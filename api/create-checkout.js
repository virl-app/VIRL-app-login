// /api/create-checkout.js
// ─────────────────────────────────────────────────────────────────────────────
// [PRICING 1] Creates a Stripe Checkout session with tier-aware pricing and
// Founder Circle cap enforcement.
//
// Auth: Supabase Bearer token required. userId + email are derived from the
// verified token – NEVER trusted from the request body. The body's userId
// gets stamped into Stripe session metadata, which the webhook then uses to
// upgrade the matching Supabase account; without token-derived identity an
// attacker could pay through their own card and credit the subscription to
// a victim's account, or upgrade a victim's plan by spoofing their UUID.
//
// POST body:
//   planType – "monthly" | "annual"  (defaults to "monthly")
//   tier     – "founder_circle" | "standard"  (defaults to "standard")
//
// Returns:
//   200 { url }                              – Stripe Checkout URL
//   401 { error: "Sign in required." }       – missing/invalid Bearer token
//   400 { error: "founder_circle_full" }     – when the cap is hit
//   400 { error: "tier_not_eligible" }       – user re-subscribing to a tier
//                                              they previously held (the
//                                              no-take-backs policy in code)
//   503 { error: "billing_not_configured" }  – graceful degradation
// ─────────────────────────────────────────────────────────────────────────────

import Stripe from "stripe";
import { claimReferralIfAny, getPendingReferralForReferred, getBankedRewardForReferrer, ensureReferralCoupon, referralMonthCents } from "./_lib/referrals.js";

const FOUNDER_CIRCLE_CAP = 50;

// [PRICING 1] Count of currently-filled founder positions. A row is "filled"
// if filled_at IS NOT NULL – covers the case where a user later deletes their
// auth.users record (user_id nulls out, but the slot stays claimed forever).
async function getFilledFounderPositions(supabaseUrl, serviceKey) {
  try {
    const res = await fetch(
      supabaseUrl + "/rest/v1/founding_positions?select=position&filled_at=not.is.null",
      {
        headers: {
          apikey: serviceKey,
          Authorization: "Bearer " + serviceKey,
          Prefer: "count=exact",
          "Range-Unit": "items",
          Range: "0-0",
        },
      }
    );
    const contentRange = res.headers.get("content-range");
    if (!contentRange) return FOUNDER_CIRCLE_CAP;  // fail closed
    const total = parseInt(contentRange.split("/")[1], 10);
    return isNaN(total) ? FOUNDER_CIRCLE_CAP : total;
  } catch (e) {
    console.error("[create-checkout] getFilledFounderPositions error:", e.message);
    return FOUNDER_CIRCLE_CAP;  // fail closed
  }
}

// [PRICING 1] Has this user ever held a founder position? Used to enforce
// the no-take-backs rule: cancelled-then-returning users must pay Standard.
async function userHasHeldFounderPosition(supabaseUrl, serviceKey, userId) {
  try {
    const res = await fetch(
      supabaseUrl + "/rest/v1/founding_positions?user_id=eq."
        + encodeURIComponent(userId) + "&select=position",
      {
        headers: {
          apikey: serviceKey,
          Authorization: "Bearer " + serviceKey,
        },
      }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    console.error("[create-checkout] userHasHeldFounderPosition error:", e.message);
    return false;  // fail open: don't block legitimate first-time signups
  }
}

// [PRICING 1] Look up the Stripe price ID for a (tier, planType) pair.
// Returns null if the env var isn't set, which lets the handler return a
// friendly 503 instead of crashing inside Stripe.
function resolvePriceId(tier, planType) {
  if (tier === "founder_circle" && planType === "monthly")
    return process.env.STRIPE_PRICE_FOUNDER_MONTHLY;
  if (tier === "founder_circle" && planType === "annual")
    return process.env.STRIPE_PRICE_FOUNDER_ANNUAL;
  if (tier === "standard" && planType === "monthly")
    return process.env.STRIPE_PRICE_STANDARD_MONTHLY;
  if (tier === "standard" && planType === "annual")
    return process.env.STRIPE_PRICE_STANDARD_ANNUAL;
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // [PRICING 1b] Accept either env var name. Restricted keys (rk_live_…)
  // are now the recommended Stripe key type; STRIPE_RESTRICTED_KEY reflects
  // that more accurately than STRIPE_SECRET_KEY. The Stripe Node SDK treats
  // both rk_ and sk_ values identically – they're just Bearer tokens.
  const stripeSecretKey = process.env.STRIPE_RESTRICTED_KEY
    || process.env.STRIPE_SECRET_KEY;
  const supabaseUrl     = process.env.SUPABASE_URL;
  const supabaseKey     = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  const appUrl          = process.env.APP_URL || "https://app.govirl.ai";

  if (!stripeSecretKey) {
    console.warn("[create-checkout] STRIPE_SECRET_KEY not set");
    return res.status(503).json({
      error: "billing_not_configured",
      message: "Billing setup is in progress. Email hello@govirl.ai to upgrade early.",
    });
  }

  const { planType: rawPlanType, tier: rawTier } = req.body || {};

  // [SECURITY] Verify caller via Supabase Bearer token and derive userId +
  // email from the verified user record. NEVER trust userId / email from
  // the request body – a body-supplied userId gets stamped into the Stripe
  // session metadata, which the webhook then uses to upgrade THAT account.
  // Without this gate, anyone could pay through their own card but credit
  // the subscription to another user's account, OR upgrade a victim's plan
  // by spoofing the userId in the body. Service key (used elsewhere in
  // this handler) bypasses RLS, so the only thing standing between an
  // attacker and cross-account writes is this auth check.
  if (!supabaseUrl || !supabaseKey) {
    return res.status(503).json({
      error: "billing_not_configured",
      message: "Billing setup is in progress. Try again shortly.",
    });
  }
  const authHeader = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!authHeader) return res.status(401).json({ error: "Sign in required." });

  let userId, email;
  try {
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${authHeader}`, apikey: supabaseKey },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Sign in required." });
    const u = await userRes.json();
    userId = u.id;
    email  = u.email;
  } catch (e) {
    return res.status(401).json({ error: "Sign in required." });
  }
  if (!userId || !email) return res.status(401).json({ error: "Sign in required." });

  // [PRICING 1] Default to "standard" for back-compat with the existing
  // index.html, which doesn't send `tier` yet (lands in Step 3).
  const tier     = rawTier === "founder_circle" ? "founder_circle" : "standard";
  const planType = rawPlanType === "annual" ? "annual" : "monthly";

  const priceId = resolvePriceId(tier, planType);
  if (!priceId) {
    console.warn("[create-checkout] No price ID for tier+plan:", tier, planType);
    return res.status(503).json({
      error: "billing_not_configured",
      message: "This pricing option isn't configured yet. Email hello@govirl.ai to upgrade.",
    });
  }

  // [PRICING 1] Founder Circle gates: cap check + eligibility check. Both
  // fail closed (return error) if Supabase is unreachable, since silently
  // letting people into a closed tier would be worse than a temporary 503.
  if (tier === "founder_circle") {
    if (!supabaseUrl || !supabaseKey) {
      console.error("[create-checkout] Supabase not configured – refusing founder_circle checkout");
      return res.status(503).json({
        error: "billing_not_configured",
        message: "Founder Circle signups are temporarily disabled. Try again shortly.",
      });
    }

    const hasHeld = await userHasHeldFounderPosition(supabaseUrl, supabaseKey, userId);
    if (hasHeld) {
      console.log("[create-checkout] User", userId, "already held a founder position – rejecting");
      return res.status(400).json({
        error: "tier_not_eligible",
        message: "Founder Circle membership is one-time. Standard pricing applies on re-subscription.",
      });
    }

    const filled = await getFilledFounderPositions(supabaseUrl, supabaseKey);
    if (filled >= FOUNDER_CIRCLE_CAP) {
      console.log("[create-checkout] Founder Circle full:", filled, "of", FOUNDER_CIRCLE_CAP);
      return res.status(400).json({
        error: "founder_circle_full",
        message: "The Founder Circle is full. Standard pricing now applies.",
      });
    }
    console.log("[create-checkout] Founder Circle:", filled, "of", FOUNDER_CIRCLE_CAP, "claimed");
  }

  try {
    const stripe = Stripe(stripeSecretKey);

    // [REFERRAL] Two possible $25-once discounts, mutually exclusive:
    //   1. The user was referred ("get a month" for the friend) – their
    //      pending referral applies the coupon to this first checkout.
    //   2. The user is a referrer redeeming a banked reward ("give a
    //      month") – earned while they weren't a paying customer yet.
    // The webhook finalizes state transitions; abandoning this checkout
    // burns nothing. All lookups fail-open to a normal full-price session.
    let discounts;
    let referralBankRowId = null;
    try {
      await claimReferralIfAny(userId);
      const pendingReferred = await getPendingReferralForReferred(userId);
      const banked = pendingReferred ? null : await getBankedRewardForReferrer(userId);
      if (pendingReferred || banked) {
        // The free month matches the plan being bought at THIS checkout:
        // $20 while Founder Circle spots remain (tier carries that), $25
        // for Standard. Same rule for a banked referrer redemption.
        const couponId = await ensureReferralCoupon(stripe, referralMonthCents(tier));
        if (couponId) {
          discounts = [{ coupon: couponId }];
          if (banked) referralBankRowId = String(banked.id);
        }
      }
    } catch (e) {
      console.warn("[create-checkout] referral discount skipped:", e.message);
    }

    // [PRICING 1] Stamp metadata at BOTH session and subscription levels
    // so the webhook can read it from either kind of event. `foundingTier`
    // is the canonical key; `isFoundingMember` stays for back-compat with
    // any pre-cutover code paths that might still read it.
    const metadata = {
      userId:           userId,
      planType:         planType,
      foundingTier:     tier,
      isFoundingMember: tier === "founder_circle" ? "true" : "false",
    };
    // [REFERRAL] Bank-redemption marker: webhook flips this row to
    // referrer_rewarded only after the discounted checkout completes.
    if (referralBankRowId) metadata.referralBankRow = referralBankRowId;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      discounts: discounts,
      metadata: metadata,
      subscription_data: { metadata: metadata },
      success_url: appUrl + "?upgraded=true&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: appUrl,
    });

    console.log(
      "[create-checkout] Created:", session.id,
      "| User:", userId,
      "| Tier:", tier,
      "| Plan:", planType
    );

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error("[create-checkout] Stripe error:", err.message);
    return res.status(500).json({
      error: "checkout_failed",
      message: "Something went wrong. Please try again.",
    });
  }
}
