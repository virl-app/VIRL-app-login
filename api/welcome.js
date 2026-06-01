// api/welcome.js  (served at /welcome via the rewrite in vercel.json)
// ─────────────────────────────────────────────────────────────────────────────
// Stripe success redirect for the Founder Circle PAYMENT-FIRST flow.
//
//   Marketing CTA → Stripe Payment Link → pay → Stripe redirects to
//   app.govirl.ai/welcome?session_id=cs_xxx → (here) → create account +
//   magic-link auto-login → dashboard with Founder Circle active.
//
// Set the Payment Link's success URL to:
//   https://app.govirl.ai/welcome?session_id={CHECKOUT_SESSION_ID}
//
// Required env:
//   STRIPE_SECRET_KEY (or STRIPE_RESTRICTED_KEY)
//   STRIPE_PRICE_FOUNDER_MONTHLY, STRIPE_PRICE_FOUNDER_ANNUAL
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   APP_URL (optional, defaults to https://app.govirl.ai)
// ─────────────────────────────────────────────────────────────────────────────

import Stripe from "stripe";
import { provisionFounderMember, isFounderPriceId } from "./_lib/founder-provision.js";

const APP_URL = process.env.APP_URL || "https://app.govirl.ai";

// Minimal branded error page. Browsers land here directly, so we render HTML
// rather than JSON. Always offers a support path — a paid user who can't get
// in is the worst-case experience, so make the next step obvious.
function errorPage(res, status, headline, detail) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VIRL — Founder Circle</title></head>
<body style="margin:0;background:#0F172A;color:#F8FAFC;font-family:Helvetica,Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
  <div style="max-width:440px;text-align:center">
    <div style="font-family:Georgia,serif;font-style:italic;font-size:30px;letter-spacing:0.06em;margin-bottom:24px;color:#fff">VIRL</div>
    <div style="font-family:Georgia,serif;font-size:24px;line-height:1.25;margin-bottom:14px">${headline}</div>
    <p style="font-size:15px;line-height:1.7;color:#94A3B8;margin:0 0 24px">${detail}</p>
    <a href="mailto:hello@govirl.ai?subject=Founder%20Circle%20checkout%20help" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;padding:14px 28px;border-radius:99px">Contact support</a>
  </div>
</body></html>`;
  res.status(status).setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(html);
}

// Stripe expands customer/subscription into objects; we only ever want the id.
function idOf(v) {
  if (!v) return null;
  return typeof v === "string" ? v : (v.id || null);
}

export default async function handler(req, res) {
  const stripeSecretKey = process.env.STRIPE_RESTRICTED_KEY || process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    console.error("[welcome] Stripe key not configured");
    return errorPage(res, 503, "We're just getting set up.",
      "Founder Circle checkout isn't fully wired yet. Email us and we'll get you in right away.");
  }

  const sessionId = (req.query && req.query.session_id) || "";
  if (!sessionId) {
    return errorPage(res, 400, "Something's missing.",
      "We couldn't find your checkout session. If you just paid, email us and we'll sort it out.");
  }

  const stripe = new Stripe(stripeSecretKey);

  // a. Validate the session by retrieving it from Stripe.
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items.data.price", "subscription", "customer"],
    });
  } catch (err) {
    console.error("[welcome] session retrieve failed:", err && err.message);
    return errorPage(res, 400, "That link looks expired.",
      "We couldn't verify your checkout session — it may have expired. Email us with your receipt and we'll get you in.");
  }

  // b. Confirm it's actually paid and the line item is a Founder Circle price.
  const paid = session.status === "complete" && session.payment_status === "paid";
  if (!paid) {
    console.warn("[welcome] session not paid:", sessionId, session.status, session.payment_status);
    return errorPage(res, 402, "We couldn't confirm payment.",
      "This checkout doesn't look complete yet. If you were charged, email us and we'll fix it.");
  }

  const lineItems = (session.line_items && session.line_items.data) || [];
  const isFounder = lineItems.some(function (li) {
    return li && li.price && isFounderPriceId(li.price.id);
  });
  if (!isFounder) {
    // Defensive: a non-FC Payment Link shouldn't point here, but never log a
    // random paid user straight into a Founder account.
    console.warn("[welcome] session has no Founder Circle price:", sessionId);
    return errorPage(res, 400, "Wrong door.",
      "This checkout isn't a Founder Circle purchase. Email us if you think this is a mistake.");
  }

  // c. Customer email is our identity anchor for the account.
  const email = session.customer_details && session.customer_details.email;
  if (!email) {
    console.error("[welcome] no customer email on session:", sessionId);
    return errorPage(res, 400, "We're missing your email.",
      "Stripe didn't pass an email with this checkout. Email us and we'll set up your account manually.");
  }

  // d–g. Create-or-upgrade the user, mark Founder Circle, mint a magic link.
  const result = await provisionFounderMember({
    email: email,
    stripeCustomerId: idOf(session.customer),
    stripeSubscriptionId: idOf(session.subscription),
    redirectTo: APP_URL + "/dashboard?fc=welcome",
  });

  if (!result.ok || !result.actionLink) {
    console.error("[welcome] provisioning failed for", email, result.error);
    return errorPage(res, 500, "Almost there.",
      "Your payment went through, but we hit a snag finishing your account. Email us — we'll have you in within minutes.");
  }

  // h. Hand the browser to Supabase's magic link, which logs the user in and
  //    redirects to the dashboard.
  console.log("[welcome] Founder Circle login for", email,
    "(created=" + result.created + ", alreadyFounder=" + result.alreadyFounder + ")");
  res.setHeader("Cache-Control", "no-store");
  return res.redirect(302, result.actionLink);
}
