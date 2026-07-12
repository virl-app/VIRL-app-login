// [GEO-GATE] Public endpoint that receives email + marketing-consent
// submissions from the non-US-visitor waitlist page (served by
// middleware.js). Inserts into public.international_waitlist with the
// caller's country header. Unauthenticated by design – the form is
// shown to anyone who hits the geo gate, including visitors who'll
// never have a VIRL account.
//
// Defenses:
//   - Email validated against a basic regex + length cap (no enforced
//     server-side deliverability check – overkill for a waitlist)
//   - Marketing consent stored as the explicit boolean from the form,
//     defaulting to FALSE (GDPR-safe – opt-in is an affirmative tick)
//   - IP captured as a salted sha256 hash so abuse patterns are
//     visible without storing PII in the clear
//   - ON CONFLICT DO NOTHING via Prefer header – re-submissions for an
//     existing email silently no-op. Acceptable: first interest stands.
//   - Always returns 200 to the client (or 400 for malformed input).
//     Even on Supabase failure, we don't surface the error – better to
//     drop a waitlist entry than to give a probing client an error oracle.

import crypto from "node:crypto";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
// Salt for the IP hash. Falls back to a constant when unset so the
// endpoint still runs in dev; rotate by setting WAITLIST_IP_SALT in
// production env vars.
const IP_SALT              = process.env.WAITLIST_IP_SALT || "virl-waitlist-default-salt";

// Conservative email format check – RFC-strict regexes are too aggressive
// for this surface. Goal: reject obvious garbage, not policy-perfect
// addresses. The actual deliverability check happens when we eventually
// try to mail them.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 255;

function hashIp(ip) {
  if (!ip) return null;
  try {
    return crypto.createHash("sha256").update(IP_SALT + "|" + ip).digest("hex");
  } catch (e) { return null; }
}

function pickClientIp(req) {
  // Vercel sets x-forwarded-for as a comma-separated list with the
  // client IP first. x-real-ip is a fallback when running behind
  // certain proxy stacks. req.socket.remoteAddress is the last
  // resort and may be a Vercel internal address.
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (xff) return xff;
  const xri = (req.headers["x-real-ip"] || "").trim();
  if (xri) return xri;
  return (req.socket && req.socket.remoteAddress) || null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    // Misconfigured – return 200 so the client's submit handler doesn't
    // show a noisy error. Log loudly so it shows up in Vercel logs.
    console.error("[waitlist] Supabase env not configured – dropping submission");
    return res.status(200).json({ ok: true });
  }

  const body              = req.body || {};
  const rawEmail          = (body.email || "").toString().trim().toLowerCase();
  const marketingOptIn    = body.marketing_opt_in === true;

  if (!rawEmail || rawEmail.length > MAX_EMAIL_LEN || !EMAIL_RE.test(rawEmail)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }

  // Vercel populates x-vercel-ip-country on every request. Will be
  // null/missing if Vercel couldn't geolocate (rare).
  const country = (req.headers["x-vercel-ip-country"] || "").toString() || null;
  const ipHash  = hashIp(pickClientIp(req));

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/international_waitlist`, {
      method: "POST",
      headers: {
        apikey:           SUPABASE_SERVICE_KEY,
        Authorization:    `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type":   "application/json",
        // ON CONFLICT DO NOTHING semantics – duplicate emails are silent
        // no-ops. We don't surface the dup to the client because the UX
        // is identical (show the "thanks" screen either way).
        Prefer:           "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify({
        email:            rawEmail,
        country:          country,
        marketing_opt_in: marketingOptIn,
        ip_hash:          ipHash,
      }),
    });
  } catch (e) {
    console.error("[waitlist] insert failed:", e.message);
    // Still return 200 – don't give the client an error oracle.
  }

  return res.status(200).json({ ok: true });
}
