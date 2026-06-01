// api/_lib/founder-provision.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared logic for the Founder Circle PAYMENT-FIRST flow (Stripe Payment Link
// → /welcome, with the stripe webhook as a safety net). Given a paid Founder
// Circle checkout, this:
//
//   1. Creates the Supabase auth user if one doesn't exist yet (random
//      password — the user sets a real one in-app or via "forgot password").
//   2. Stamps user_metadata.is_founder_circle (the source-of-truth flag) plus
//      the stripe ids and a password_set sentinel.
//   3. Claims a founding_position (reusing the same atomic RPC the account-
//      first webhook uses) and writes a credits row with plan='founding' /
//      founding_tier='founder_circle' — so server-side gating (api/chat.js
//      keys off credits.plan) and the in-app paywall skip work end to end,
//      not just the metadata flag.
//
// Idempotent by design (see provisionFounderMember): safe when /welcome and
// the webhook race, or when Stripe retries the webhook. The
// user_metadata.is_founder_circle flag is the sentinel that tells a second
// caller "this email was already turned into a Founder" so it doesn't re-send
// the welcome email.
//
// This is the payment-first counterpart to the account-first path inside
// stripe-webhook.js. The two are intentionally separate: the account-first
// path already has a userId in checkout metadata, this one resolves the user
// from the customer email instead.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import { createUser, updateUserMetadata, generateMagicLink } from "./supabase-admin.js";

// The same env vars create-checkout.js already resolves prices from. A raw
// Payment Link can only ever charge one of these for Founder Circle, so they
// double as the allowlist /welcome and the webhook validate line items against.
function founderPriceIds() {
  return [
    process.env.STRIPE_PRICE_FOUNDER_MONTHLY,
    process.env.STRIPE_PRICE_FOUNDER_ANNUAL,
  ].filter(Boolean);
}

function isFounderPriceId(priceId) {
  if (!priceId) return false;
  return founderPriceIds().indexOf(priceId) !== -1;
}

// ── credits / founding_position writes ───────────────────────────────────────
// Mirrors the helpers in stripe-webhook.js. Kept here (rather than imported)
// so the payment-first path is self-contained and a future refactor of the
// account-first webhook can't accidentally regress it.

async function getCreditRow(userId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey || !userId) return null;
  try {
    const res = await fetch(
      supabaseUrl + "/rest/v1/credits?user_id=eq."
        + encodeURIComponent(userId)
        + "&select=subscription_started_at,founding_tier,founding_position",
      { headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows && rows[0] ? rows[0] : null;
  } catch (e) {
    console.error("[founder-provision] getCreditRow error:", e.message);
    return null;
  }
}

async function claimFoundingPosition(userId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey || !userId) return null;
  try {
    const res = await fetch(supabaseUrl + "/rest/v1/rpc/claim_founding_position", {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: "Bearer " + serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_user_id: userId }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("[founder-provision] claim_founding_position failed:", res.status, text);
      return null;
    }
    const data = await res.json();
    return (typeof data === "number") ? data : null;
  } catch (e) {
    console.error("[founder-provision] claim_founding_position error:", e.message);
    return null;
  }
}

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
      // No row yet (brand-new payment-first user has never generated). 150
      // credits mirrors the paid-tier allowance other paid users carry.
      res = await fetch(supabaseUrl + "/rest/v1/credits", {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: "Bearer " + serviceKey,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(Object.assign({ user_id: userId, credits: 150 }, fields)),
      });
    }
    if (!res.ok) {
      const text = await res.text();
      console.error("[founder-provision] credits write failed:", res.status, text);
    }
  } catch (e) {
    console.error("[founder-provision] credits write error:", e.message);
  }
}

// ── Main entry point ─────────────────────────────────────────────────────────
// Provision (or re-confirm) a Founder Circle member from their email. Always
// returns a fresh magic link so the caller can either redirect (/welcome) or
// email it (webhook safety net).
//
// Args:
//   email                — Stripe customer email (required)
//   stripeCustomerId     — for user_metadata + credits
//   stripeSubscriptionId — for user_metadata
//   redirectTo           — where the magic link lands the user
//
// Returns:
//   { ok, userId, actionLink, created, alreadyFounder, error }
//     created        — true when we created a brand-new auth user just now
//     alreadyFounder — true when this email was ALREADY a Founder before this
//                      call (a prior /welcome or webhook handled it). The
//                      webhook uses this to avoid sending a duplicate welcome
//                      email; /welcome ignores it and logs the user in anyway.
async function provisionFounderMember({ email, stripeCustomerId, stripeSubscriptionId, redirectTo }) {
  if (!email) return { ok: false, error: "missing_email" };

  const nowIso = new Date().toISOString();
  const founderMeta = {
    is_founder_circle: true,
    founder_circle_started: nowIso,
    stripe_customer_id: stripeCustomerId || null,
    stripe_subscription_id: stripeSubscriptionId || null,
  };

  // 1. Create the auth user (idempotent). A brand-new payment-first user has
  //    never picked a password, so password_set starts false → the in-app
  //    prompt nudges them to set one. The random password is throwaway.
  const create = await createUser({
    email: email,
    password: crypto.randomBytes(32).toString("hex"),
    userMetadata: Object.assign({ password_set: false }, founderMeta),
  });

  let created = false;
  if (create.ok) {
    created = true;
  } else if (!create.exists) {
    // A real failure (not "already exists") — bail so the caller can surface
    // a support error rather than redirect into a half-provisioned state.
    return { ok: false, error: create.error || "create_failed" };
  }

  // 2. Mint the magic link. This also resolves the user id + current metadata
  //    for the existing-user path (no stable get-user-by-email endpoint).
  const link = await generateMagicLink({ email: email, redirectTo: redirectTo });
  if (!link.ok || !link.userId) {
    return { ok: false, error: link.error || "link_failed", created: created };
  }
  const userId = link.userId;
  const priorMeta = link.userMetadata || {};

  // "Already a Founder" only counts when we DIDN'T just create them — a user
  // we created this call has is_founder_circle set, but that's not a prior
  // provision. This drives email-dedup in the webhook.
  const alreadyFounder = !created && priorMeta.is_founder_circle === true;

  // 3. For an existing account (free-trial upgrade, or a re-run), merge the
  //    Founder flag into their metadata without clobbering other fields.
  //    Existing accounts already have a real password (trial signup requires
  //    one), so default password_set → true and don't prompt them. A prior
  //    payment-first user keeps whatever password_set they already had.
  if (!created) {
    const mergedMeta = Object.assign({}, priorMeta, founderMeta, {
      // preserve the earliest start date if one's already recorded
      founder_circle_started: priorMeta.founder_circle_started || nowIso,
      password_set: priorMeta.password_set != null ? priorMeta.password_set : true,
    });
    await updateUserMetadata(userId, mergedMeta);
  }

  // 4. Claim a founding_position + write the credits row so the app treats
  //    them as a paid Founder everywhere (paywall skip, server gating, admin
  //    stats). All idempotent: the RPC returns the existing position on
  //    replay; subscription_started_at is only stamped on first provision.
  const foundingPosition = await claimFoundingPosition(userId);
  if (foundingPosition === null) {
    console.warn("[founder-provision] Founder Circle overflow — user " + userId + " has no position");
  }
  const existing = await getCreditRow(userId);
  const patchFields = {
    plan: "founding",
    founding_tier: "founder_circle",
    stripe_customer_id: stripeCustomerId || null,
  };
  if (foundingPosition !== null) patchFields.founding_position = foundingPosition;
  if (!existing || !existing.subscription_started_at) {
    patchFields.subscription_started_at = nowIso;
  }
  await writeUserPlan(userId, patchFields, existing != null);

  return {
    ok: true,
    userId: userId,
    actionLink: link.actionLink,
    created: created,
    alreadyFounder: alreadyFounder,
  };
}

export { provisionFounderMember, isFounderPriceId, founderPriceIds };
