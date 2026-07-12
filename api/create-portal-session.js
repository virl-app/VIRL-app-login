// /api/create-portal-session.js
// ─────────────────────────────────────────────────────────────────────────────
// [CX-FIX 2] Creates a Stripe Customer Portal session and returns the hosted
// URL. The user is redirected there to manage their subscription themselves –
// update card, view invoices, cancel – without emailing support.
//
// POST body: { userId }     // userId taken from req.body OR derived from
//                              the bearer token (token wins if both)
// Returns:   { url }        // Stripe-hosted portal URL
//
// Required env:
//   STRIPE_SECRET_KEY / STRIPE_RESTRICTED_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   APP_URL – used as the return_url after the portal session
//
// Required Stripe Dashboard setup (one-time, no code):
//   Settings → Billing → Customer portal → enable + configure which actions
//   are allowed (update payment method, cancel subscription, etc.).
// ─────────────────────────────────────────────────────────────────────────────

import Stripe from "stripe";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_URL              = process.env.APP_URL || "https://app.govirl.ai";

async function fetchStripeCustomerId(userId) {
  if (!userId || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const res = await fetch(
      SUPABASE_URL + "/rest/v1/credits?user_id=eq."
        + encodeURIComponent(userId) + "&select=stripe_customer_id",
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
        },
      }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return (rows && rows[0] && rows[0].stripe_customer_id) || null;
  } catch (e) {
    console.error("[create-portal-session] customer id fetch failed:", e.message);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const stripeSecretKey = process.env.STRIPE_RESTRICTED_KEY
    || process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    console.warn("[create-portal-session] STRIPE_SECRET_KEY not set");
    return res.status(503).json({
      error: "billing_not_configured",
      message: "Billing isn't set up yet. Email hello@govirl.ai for help.",
    });
  }

  // Verify the caller against Supabase auth, same pattern as the welcome +
  // password-changed endpoints. The userId comes from the verified token,
  // never trust a client-supplied userId in body.
  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Sign in required." });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }

  let userId;
  try {
    const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Sign in required." });
    const u = await userRes.json();
    userId = u && u.id;
    if (!userId) return res.status(401).json({ error: "Sign in required." });
  } catch (e) {
    return res.status(401).json({ error: "Sign in required." });
  }

  const customerId = await fetchStripeCustomerId(userId);
  if (!customerId) {
    // User has never completed a Stripe checkout – there's no portal session
    // to create. Return a clear error so the UI can hide the button or show
    // a "subscribe first" hint.
    return res.status(400).json({
      error: "no_subscription",
      message: "No subscription found. Subscribe first to manage billing here.",
    });
  }

  try {
    const stripe = Stripe(stripeSecretKey);
    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: APP_URL,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[create-portal-session] Stripe error:", err.message);
    return res.status(500).json({
      error: "portal_failed",
      message: "Couldn't open the billing portal. Try again, or email hello@govirl.ai.",
    });
  }
}
