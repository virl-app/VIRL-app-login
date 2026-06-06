// /api/stripe-webhook.js
// ─────────────────────────────────────────────────────────────────────────────
// Receives Stripe webhook events and syncs subscription status into Supabase.
// Always returns 200 (after the signature has been verified) so Stripe doesn't
// retry indefinitely on transient bugs. Uses SUPABASE_SERVICE_KEY so writes
// bypass RLS.
//
// Required env:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// ─────────────────────────────────────────────────────────────────────────────

import Stripe from "stripe";
import { sendEmail } from "./_lib/email-send.js";
import {
  paymentFailed,
  subscriptionCancelled,
  renewalUpcoming,
} from "./_lib/email-templates.js";
// [PREMIUM 7] Loops lifecycle event triggers (subscriptionStarted /
// subscriptionCancelled) + contact-property sync so Loops can drive
// plan-state-aware emails inside its own dashboard.
import { sendLoopsEvent, updateLoopsContact } from "./_lib/loops.js";

// [CHANGE 3b] Disable Vercel's body parser so Stripe gets the exact raw bytes
// it signed — any reformatting would invalidate the signature.
export const config = { api: { bodyParser: false } };

// Best-effort lookup for personalized greetings — never blocks the webhook.
// [EMAIL-CUTOVER] Now also surfaces signupAt + marketingSubscribed so the
// downstream updateLoopsContact calls can include the §9 fields without
// requiring a second auth.users fetch per webhook.
async function fetchUserContext(userId) {
  const out = { email: null, name: "", signupAt: null, marketingSubscribed: false };
  if (!userId) return out;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return out;
  try {
    const userRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (userRes.ok) {
      const u = await userRes.json();
      out.email    = u.email || null;
      out.signupAt = u.created_at || null;
      const meta   = (u.user_metadata) || {};
      out.marketingSubscribed = !!meta.marketing_opt_in;
    }
    const profRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${userId}&select=name`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    if (profRes.ok) {
      const rows = await profRes.json();
      if (rows[0] && rows[0].name) out.name = rows[0].name;
    }
  } catch (e) { /* non-fatal */ }
  return out;
}

async function readRawBody(req) {
  return await new Promise(function (resolve, reject) {
    const chunks = [];
    req.on("data", function (chunk) { chunks.push(chunk); });
    req.on("end",  function () { resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

async function patchUserPlan(userId, fields) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey || !userId) return;
  try {
    const res = await fetch(
      supabaseUrl + "/rest/v1/credits?user_id=eq." + encodeURIComponent(userId),
      {
        method: "PATCH",
        headers: {
          apikey: serviceKey,
          Authorization: "Bearer " + serviceKey,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(fields),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      console.error("[webhook] Supabase PATCH failed:", res.status, text);
    }
  } catch (e) {
    console.error("[webhook] Supabase PATCH error:", e.message);
  }
}

// [PRICING 1] Fetch the current credits row so we can tell first-signup
// (subscription_started_at IS NULL) from resubscription. Returns null on
// any failure — caller treats null as "assume first signup," which only
// affects the resubscription counter (cosmetic for admin dashboards).
async function getCreditRow(userId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey || !userId) return null;
  try {
    const res = await fetch(
      supabaseUrl + "/rest/v1/credits?user_id=eq."
        + encodeURIComponent(userId)
        + "&select=subscription_started_at,resubscription_count,founding_tier,founding_position",
      {
        headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
      }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows && rows[0] ? rows[0] : null;
  } catch (e) {
    console.error("[webhook] getCreditRow error:", e.message);
    return null;
  }
}

// [PRICING 1] Atomically claim a founding_position via the Postgres RPC.
// Returns the position number (1..50), or null if all positions are
// already filled (documented overflow window per the brief). Idempotent
// inside the RPC itself — a webhook retry returns the same position.
async function claimFoundingPosition(userId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey || !userId) return null;
  try {
    const res = await fetch(
      supabaseUrl + "/rest/v1/rpc/claim_founding_position",
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: "Bearer " + serviceKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_user_id: userId }),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      console.error("[webhook] claim_founding_position RPC failed:", res.status, text);
      return null;
    }
    const data = await res.json();
    // PostgREST RPC returns the scalar directly for scalar-returning fns.
    return (typeof data === "number") ? data : null;
  } catch (e) {
    console.error("[webhook] claim_founding_position error:", e.message);
    return null;
  }
}

// [PRICING 3b] Write plan fields to the user's credits row, creating the
// row if it doesn't exist yet. VIRL provisions the credits row lazily (on
// first plan generation), so a user who signs up and upgrades before
// generating anything has no row — a plain PATCH would silently no-op and
// the upgrade would be lost. `rowExists` comes from the getCreditRow call
// the caller already made, so this adds no extra round-trip.
async function writeUserPlan(userId, fields, rowExists) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey || !userId) return;
  try {
    let res;
    if (rowExists) {
      res = await fetch(
        supabaseUrl + "/rest/v1/credits?user_id=eq." + encodeURIComponent(userId),
        {
          method: "PATCH",
          headers: {
            apikey: serviceKey,
            Authorization: "Bearer " + serviceKey,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify(fields),
        }
      );
    } else {
      // No row yet — insert. credits:150 mirrors the paid-tier allowance
      // other paid users carry (the HUD renders "Unlimited" for paid plans
      // regardless, so the number is a convention, not a gate).
      res = await fetch(
        supabaseUrl + "/rest/v1/credits",
        {
          method: "POST",
          headers: {
            apikey: serviceKey,
            Authorization: "Bearer " + serviceKey,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify(Object.assign({ user_id: userId, credits: 150 }, fields)),
        }
      );
    }
    if (!res.ok) {
      const text = await res.text();
      console.error("[webhook] credits write failed:", res.status, text);
    }
  } catch (e) {
    console.error("[webhook] credits write error:", e.message);
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // [PRICING 1b] Accept either env var name — matches the same change in
    // create-checkout.js so a restricted-key (rk_live_…) deployment can be
    // named accurately as STRIPE_RESTRICTED_KEY without a code change.
    const stripeSecretKey = process.env.STRIPE_RESTRICTED_KEY
      || process.env.STRIPE_SECRET_KEY;
    const webhookSecret   = process.env.STRIPE_WEBHOOK_SECRET;

    // If Stripe isn't configured yet, swallow the event with 200 so Stripe
    // doesn't retry. This mirrors the graceful-degradation pattern in
    // create-checkout.js — the dashboard simply won't be sending events yet.
    if (!stripeSecretKey || !webhookSecret) {
      console.warn("[webhook] Stripe not configured — ignoring event");
      return res.status(200).json({ received: true });
    }

    const stripe  = new Stripe(stripeSecretKey);
    const rawBody = await readRawBody(req);
    const sig     = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (err) {
      console.error("[webhook] Signature verification failed:", err.message);
      return res.status(400).json({ error: "invalid_signature" });
    }

    // [STRIPE-IDEMPOTENCY] Try to claim this event.id in the dedupe table.
    // If the INSERT conflicts (409), this is a retry of an event we've
    // already processed — return 200 immediately so Stripe stops retrying
    // and we don't double-fire side effects (resubscription_count
    // increments, Loops events, etc.).
    //
    // Insert-at-top trade-off: a handler that crashes mid-flight (after
    // claiming event_id but before all side effects run) leaves the
    // event marked processed; a Stripe retry would skip the rest. We
    // accept that vs the alternative (insert-at-end) which risks
    // parallel deliveries of the same event running side effects twice.
    //
    // Fail-open if the dedupe table itself is unreachable — better to
    // risk an over-counted increment than to refuse all webhook
    // deliveries on a Supabase blip.
    const supabaseUrl     = process.env.SUPABASE_URL;
    const supabaseService = process.env.SUPABASE_SERVICE_KEY;
    if (supabaseUrl && supabaseService && event && event.id) {
      try {
        const dedupeRes = await fetch(`${supabaseUrl}/rest/v1/processed_stripe_events`, {
          method: "POST",
          headers: {
            apikey:           supabaseService,
            Authorization:    `Bearer ${supabaseService}`,
            "Content-Type":   "application/json",
            Prefer:           "return=minimal",
          },
          body: JSON.stringify({ event_id: event.id }),
        });
        // 201 Created → first delivery, proceed. 409 Conflict → already
        // processed. Anything else (5xx, network blip) → fail-open and
        // let the handler run; worst case a side effect double-fires
        // once, which is the existing behavior.
        if (dedupeRes.status === 409) {
          console.log("[webhook] event already processed, skipping:", event.id, event.type);
          return res.status(200).json({ received: true, deduped: true });
        }
      } catch (e) {
        console.warn("[webhook] dedupe insert failed (fail-open):", e.message);
      }
    }

    const obj    = (event && event.data && event.data.object) || {};
    const meta   = obj.metadata || {};
    const userId = meta.userId || null;

    switch (event.type) {
      case "checkout.session.completed": {
        // [PRICING 1] Prefer the new foundingTier metadata key; fall back
        // to the legacy isFoundingMember boolean for any pre-cutover
        // sessions still in flight when this code deployed.
        const foundingTier = meta.foundingTier
          || (meta.isFoundingMember === "true" ? "founder_circle" : "standard");
        const plan = foundingTier === "founder_circle" ? "founding" : "standard";
        // [PREMIUM 7] planType reflects the user's billing cadence
        // (monthly vs annual) so Loops can pick between the standard
        // welcome and the annual-thank-you variants. Pulled from
        // checkout metadata where the client stamped it.
        const planType = (meta.planType === "annual") ? "annual" : "monthly";
        if (userId) {
          // [PRICING 1] Atomically claim a founding_position for new
          // Founder Circle members. Returns null when all 50 slots are
          // already filled — caller still sets founding_tier to keep the
          // user's identity correct, but founding_position stays NULL
          // (the documented 1-2-over race window).
          let foundingPosition = null;
          if (foundingTier === "founder_circle") {
            foundingPosition = await claimFoundingPosition(userId);
            if (foundingPosition === null) {
              console.warn("[webhook] Founder Circle overflow — user " + userId + " has no position");
            } else {
              console.log("[webhook] User " + userId + " assigned founder position " + foundingPosition);
            }
          }

          // [PRICING 1] Distinguish first signup from resubscription so
          // subscription_started_at is locked once and resubscription
          // metadata is bumped on returns. getCreditRow returning null
          // (Supabase blip) degrades to treating as first signup — only
          // affects the resub counter, never breaks the upgrade.
          const existing = await getCreditRow(userId);
          const isFirstSignup = !existing || !existing.subscription_started_at;
          const nowIso = new Date().toISOString();

          const patchFields = {
            plan: plan,
            stripe_customer_id: obj.customer || null,
            founding_tier: foundingTier,
          };
          if (foundingPosition !== null) {
            patchFields.founding_position = foundingPosition;
          }
          if (isFirstSignup) {
            patchFields.subscription_started_at = nowIso;
          } else {
            patchFields.last_resubscribed_at = nowIso;
            patchFields.resubscription_count = (existing && existing.resubscription_count
              ? existing.resubscription_count
              : 0) + 1;
          }

          // [PRICING 3b] writeUserPlan creates the credits row if it's
          // missing (lazy-provisioned users who upgrade before generating).
          await writeUserPlan(userId, patchFields, existing != null);
          console.log("[webhook] User " + userId + " upgraded to " + plan + " (" + foundingTier + ")");
          // Subscription welcome — dedupe by stripe subscription id so a
          // resubscribe creates a new send, but a webhook replay does not.
          const ctx   = await fetchUserContext(userId);
          if (ctx.email) {
            // [CX-FIX 5] Loops now owns the post-subscription welcome
            // (driven by the subscriptionStarted event below) — tier-
            // aware variants are easier to author there than in code.
            // The Resend transactional welcome that used to fire here
            // is intentionally removed; otherwise new subscribers
            // received two welcomes (one from Resend, one from Loops).
            // The subscriptionWelcome template is kept in
            // email-templates.js for now in case we want to fall back.
            //
            // [PREMIUM 7] Fire subscriptionStarted into Loops + sync
            // plan-state properties so time-based segments (annual
            // upgrade nudge at day 60, etc) have what they need.
            // [PRICING 6] foundingTier + foundingPosition let Loops branch
            // the welcome (Email 01) and payment confirmation (Email 04)
            // into tier-aware variants and personalize "You're Founder #N".
            await sendLoopsEvent({
              userId, email: ctx.email, eventName: "subscriptionStarted",
              properties: {
                firstName:        ctx.name || "",
                planType:         planType,
                foundingTier:     foundingTier,
                foundingPosition: foundingPosition || 0,
                isFoundingMember: plan === "founding",
              },
            });
            await updateLoopsContact({
              userId, email: ctx.email,
              properties: {
                plan:             plan,
                planType:         planType,
                foundingTier:     foundingTier,
                foundingPosition: foundingPosition || 0,
                isFoundingMember: plan === "founding",
                // [EMAIL-CUTOVER] §9 fields — surfaced here so Loops audience
                // filters keyed on signupAt (trial-day-N) and
                // marketingSubscribed (suppression) stay in sync even if
                // a contact was created in Loops via this webhook before
                // /api/email/welcome fired (rare but possible for users
                // who pay before completing the inline auth flow).
                signupAt:            ctx.signupAt || undefined,
                marketingSubscribed: ctx.marketingSubscribed,
              },
            });
            // [PRICING 6] When the 50th Founder Circle position is claimed,
            // fire foundingCircleFull. claim_founding_position always takes
            // the lowest empty slot, so position 50 is necessarily the last
            // filled — this fires exactly once. The event lands on the 50th
            // member's contact; broadcasting the "Founder Circle is full"
            // email to the wider waitlist is a Loops campaign triggered
            // separately (the event is the signal that the moment arrived).
            if (foundingTier === "founder_circle" && foundingPosition === 50) {
              await sendLoopsEvent({
                userId, email: ctx.email, eventName: "foundingCircleFull",
                properties: { filledCount: 50 },
              });
              console.log("[webhook] Founder Circle filled — foundingCircleFull fired");
            }
          }
        } else {
          console.warn("[webhook] checkout.session.completed missing userId in metadata");
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        if (!userId) {
          console.warn("[webhook] " + event.type + " missing userId in metadata");
          break;
        }
        const status = obj.status;
        if (status === "past_due" || status === "unpaid") {
          await patchUserPlan(userId, { plan: "past_due", stripe_customer_id: obj.customer || null });
          console.log("[webhook] User " + userId + " marked past_due");
          // Payment failed email — dedupe by stripe sub id + month so the
          // user gets at most one nudge per billing cycle, even if Stripe
          // flips status back and forth on retries.
          const ymKey = new Date().toISOString().slice(0, 7); // YYYY-MM
          const ctx   = await fetchUserContext(userId);
          if (ctx.email) {
            const tpl = paymentFailed({ name: ctx.name });
            await sendEmail({
              userId, to: ctx.email, template: "payment_failed",
              dedupeKey: `past_due_${obj.id || "sub"}_${ymKey}`,
              subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: false,
            });
          }
        } else if (status === "active" || status === "trialing") {
          // trialing also gets the paid plan — they've completed checkout and
          // entered the subscription's trial window, which is functionally
          // paid from our gating perspective.
          // [PRICING 1] Match the checkout.session.completed handler's
          // tier resolution so subscription-level events agree with
          // session-level ones. Don't overwrite founding_tier here —
          // identity is set once at checkout and is immutable.
          const foundingTier = meta.foundingTier
            || (meta.isFoundingMember === "true" ? "founder_circle" : "standard");
          const plan = foundingTier === "founder_circle" ? "founding" : "standard";
          await patchUserPlan(userId, { plan: plan, stripe_customer_id: obj.customer || null });
          console.log("[webhook] User " + userId + " set to " + plan + " via " + event.type + " (" + status + ")");
        }
        break;
      }

      case "invoice.upcoming": {
        // Stripe fires this 3-7 days before a subscription renewal (lead
        // time configurable per subscription). The invoice object doesn't
        // carry our metadata.userId, so we resolve the user via their
        // stripe_customer_id stored in public.credits.
        try {
          const customerId = obj.customer;
          const supabaseUrl = process.env.SUPABASE_URL;
          const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
          if (!customerId || !supabaseUrl || !serviceKey) break;

          const credRes = await fetch(
            `${supabaseUrl}/rest/v1/credits?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=user_id,plan`,
            { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
          );
          if (!credRes.ok) break;
          const rows = await credRes.json();
          const row = rows && rows[0];
          if (!row || !row.user_id) break;

          const ctx = await fetchUserContext(row.user_id);
          if (!ctx.email) break;

          // Stripe invoice amounts come in cents; renewal date is the
          // period_end of the upcoming invoice.
          const amountUsd = (obj.amount_due || obj.total || 0) / 100;
          const renewalDate = obj.period_end ? new Date(obj.period_end * 1000).toISOString() : null;

          // Dedupe by the invoice id when present, otherwise by the
          // upcoming-period-end so we never send twice for the same renewal.
          const dedupeKey = "renewal_" + (obj.id || ("p" + (obj.period_end || Date.now())));

          const tpl = renewalUpcoming({
            name:        ctx.name,
            plan:        row.plan,
            amountUsd:   amountUsd,
            renewalDate: renewalDate,
          });
          await sendEmail({
            userId:    row.user_id,
            to:        ctx.email,
            template:  "renewal_upcoming",
            dedupeKey,
            subject:   tpl.subject,
            html:      tpl.html,
            text:      tpl.text,
            marketing: false,
          });
        } catch (e) {
          console.error("[webhook] invoice.upcoming threw", e && e.message);
        }
        break;
      }

      case "customer.subscription.deleted": {
        if (!userId) {
          console.warn("[webhook] subscription.deleted missing userId in metadata");
          break;
        }
        // [PRICING 6] Read the member's tier before flipping plan state so
        // the cancellation event tells Loops whether a Founder Circle member
        // churned (worth Lauren's personal follow-up per the brief) versus a
        // Standard one. founding_tier itself is never cleared on cancel —
        // the position stays filled forever (no-take-backs rule).
        const cancelledCredit = await getCreditRow(userId);
        const cancelledTier = (cancelledCredit && cancelledCredit.founding_tier) || "standard";
        // Mark the plan cancelled but DO NOT delete user data — they may
        // resubscribe and we want their vault, profile, and history intact.
        await patchUserPlan(userId, { plan: "cancelled" });
        console.log("[webhook] User " + userId + " cancelled (" + cancelledTier + ")");
        const ctx = await fetchUserContext(userId);
        if (ctx.email) {
          const tpl = subscriptionCancelled({ name: ctx.name });
          await sendEmail({
            userId, to: ctx.email, template: "subscription_cancelled",
            dedupeKey: "cancel_" + (obj.id || "sub"),
            subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: false,
          });
          // [PREMIUM 7] Fire subscriptionCancelled + flip the contact's
          // plan property so the day-60 reactivation segment in Loops
          // can target this user.
          await sendLoopsEvent({
            userId, email: ctx.email, eventName: "subscriptionCancelled",
            properties: { firstName: ctx.name || "", foundingTier: cancelledTier },
          });
          await updateLoopsContact({
            userId, email: ctx.email,
            properties: {
              plan:                "cancelled",
              foundingTier:        cancelledTier,
              // [EMAIL-CUTOVER] §9 — keep marketingSubscribed mirrored so a
              // cancelled customer who didn't unsubscribe stays opted in
              // for the monthly editorial (per the strategic stance: a
              // cancellation isn't an unsubscribe).
              signupAt:            ctx.signupAt || undefined,
              marketingSubscribed: ctx.marketingSubscribed,
            },
          });
        }
        break;
      }

      default:
        // Other event types are ignored intentionally.
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    // Never let an unexpected bug 5xx the webhook — Stripe will retry forever.
    console.error("[webhook] Unhandled error:", err && err.message);
    return res.status(200).json({ received: true });
  }
}
