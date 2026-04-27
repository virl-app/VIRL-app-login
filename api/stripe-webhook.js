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
  subscriptionWelcome,
  paymentFailed,
  subscriptionCancelled,
} from "./_lib/email-templates.js";

// [CHANGE 3b] Disable Vercel's body parser so Stripe gets the exact raw bytes
// it signed — any reformatting would invalidate the signature.
export const config = { api: { bodyParser: false } };

// Best-effort lookup for personalized greetings — never blocks the webhook.
async function fetchUserContext(userId) {
  const out = { email: null, name: "" };
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
      out.email = u.email || null;
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

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
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

    const obj    = (event && event.data && event.data.object) || {};
    const meta   = obj.metadata || {};
    const userId = meta.userId || null;

    switch (event.type) {
      case "checkout.session.completed": {
        const isFoundingMember = meta.isFoundingMember;
        const plan = isFoundingMember === "true" ? "founding" : "standard";
        if (userId) {
          await patchUserPlan(userId, {
            plan: plan,
            stripe_customer_id: obj.customer || null,
          });
          console.log("[webhook] User " + userId + " upgraded to " + plan);
          // Subscription welcome — dedupe by stripe subscription id so a
          // resubscribe creates a new send, but a webhook replay does not.
          const subId = obj.subscription || obj.id || "session";
          const ctx   = await fetchUserContext(userId);
          if (ctx.email) {
            const tpl = subscriptionWelcome({ name: ctx.name, plan });
            await sendEmail({
              userId, to: ctx.email, template: "subscription_welcome",
              dedupeKey: "sub_" + subId,
              subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: false,
            });
          }
        } else {
          console.warn("[webhook] checkout.session.completed missing userId in metadata");
        }
        break;
      }

      case "customer.subscription.updated": {
        if (!userId) {
          console.warn("[webhook] subscription.updated missing userId in metadata");
          break;
        }
        const status = obj.status;
        if (status === "past_due" || status === "unpaid") {
          await patchUserPlan(userId, { plan: "past_due" });
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
        } else if (status === "active") {
          const plan = meta.isFoundingMember === "true" ? "founding" : "standard";
          await patchUserPlan(userId, { plan: plan });
          console.log("[webhook] User " + userId + " reactivated to " + plan);
        }
        break;
      }

      case "customer.subscription.deleted": {
        if (!userId) {
          console.warn("[webhook] subscription.deleted missing userId in metadata");
          break;
        }
        // Mark the plan cancelled but DO NOT delete user data — they may
        // resubscribe and we want their vault, profile, and history intact.
        await patchUserPlan(userId, { plan: "cancelled" });
        console.log("[webhook] User " + userId + " cancelled");
        const ctx = await fetchUserContext(userId);
        if (ctx.email) {
          const tpl = subscriptionCancelled({ name: ctx.name });
          await sendEmail({
            userId, to: ctx.email, template: "subscription_cancelled",
            dedupeKey: "cancel_" + (obj.id || "sub"),
            subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: false,
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
