// /api/create-checkout.js
// ─────────────────────────────────────────────────────────────────────────────
// Creates a Stripe Checkout session and returns the hosted payment URL.
// Called by the frontend handleCheckout() function when a user taps Upgrade.
//
// POST body: { userId, email, planType }
//   userId   — Supabase user UUID (used to track founding member status)
//   email    — Pre-fills Stripe's email field for smoother UX
//   planType — "monthly" | "annual"
//
// Returns: { url } — the Stripe Checkout URL to redirect the user to
// ─────────────────────────────────────────────────────────────────────────────

import Stripe from "stripe";

const FOUNDING_CAP = 100;

async function getPaidUserCount(supabaseUrl, supabaseServiceKey) {
  try {
    const res = await fetch(
      supabaseUrl + "/rest/v1/credits?select=plan&or=(plan.eq.founding,plan.eq.standard)&limit=1",
      {
        headers: {
          apikey: supabaseServiceKey,
          Authorization: "Bearer " + supabaseServiceKey,
          Prefer: "count=exact",
          "Range-Unit": "items",
          Range: "0-0",
        },
      }
    );
    const contentRange = res.headers.get("content-range");
    if (!contentRange) return FOUNDING_CAP;
    const total = parseInt(contentRange.split("/")[1], 10);
    return isNaN(total) ? FOUNDING_CAP : total;
  } catch (e) {
    console.error("[create-checkout] getPaidUserCount error:", e.message);
    return FOUNDING_CAP;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const monthlyPriceId  = process.env.STRIPE_PRICE_ID;
  const annualPriceId   = process.env.STRIPE_ANNUAL_PRICE_ID;
  const foundingCoupon  = process.env.STRIPE_FOUNDING_COUPON;
  const supabaseUrl     = process.env.SUPABASE_URL;
  const supabaseKey     = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  const appUrl          = process.env.APP_URL || "https://app.govirl.ai";

  // Graceful degradation — if Stripe is not yet configured, return a
  // friendly message instead of crashing. Remove once Stripe is live.
  if (!stripeSecretKey || !monthlyPriceId) {
    console.warn("[create-checkout] Stripe not configured");
    return res.status(503).json({
      error: "billing_not_configured",
      message: "Billing setup is in progress. Email hello@govirl.ai to upgrade early.",
    });
  }

  const { userId, email, planType } = req.body || {};

  if (!userId || !email) {
    return res.status(400).json({ error: "userId and email are required" });
  }

  const isAnnual = planType === "annual";
  const priceId  = isAnnual ? annualPriceId : monthlyPriceId;

  if (!priceId) {
    console.error("[create-checkout] Missing price ID for planType:", planType);
    return res.status(500).json({ error: "Price not configured for selected plan" });
  }

  try {
    const stripe = Stripe(stripeSecretKey);

    // Check founding member eligibility
    let isFoundingMember = false;
    if (foundingCoupon && supabaseUrl) {
      const paidCount = await getPaidUserCount(supabaseUrl, supabaseKey);
      isFoundingMember = paidCount < FOUNDING_CAP;
      console.log("[create-checkout] Paid count:", paidCount, "| Founding:", isFoundingMember);
    }

    const sessionParams = {
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: {
          userId: userId,
          planType: isAnnual ? "annual" : "monthly",
          isFoundingMember: isFoundingMember ? "true" : "false",
        },
      },
      ...(isFoundingMember && foundingCoupon
        ? { discounts: [{ coupon: foundingCoupon }] }
        : {}),
      success_url: appUrl + "?upgraded=true&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: appUrl,
      customer_creation: "always",
    };

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log(
      "[create-checkout] Created:", session.id,
      "| User:", userId,
      "| Plan:", planType,
      "| Founding:", isFoundingMember
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