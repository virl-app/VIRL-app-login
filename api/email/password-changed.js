// /api/email/password-changed.js
// ─────────────────────────────────────────────────────────────────────────────
// [CX-FIX 1] Sends the "your password was just changed" notification email.
// Triggered client-side from SetNewPasswordScreen (the recovery flow) and the
// future signed-in change-password UI.
//
// Security best practice: if someone compromises an account and resets the
// password, the legitimate owner sees this email and can react. Supabase Auth
// doesn't send this on its own.
//
// Auth: requires the user's bearer token. We verify it against Supabase auth
// and use the returned email — never trust a client-supplied target address
// here, because an attacker who could call this endpoint with someone else's
// email could spam them with bogus password-change notifications.
// ─────────────────────────────────────────────────────────────────────────────

import { sendEmail, emailEnabled } from "../_lib/email-send.js";
import { passwordChanged as passwordChangedTemplate } from "../_lib/email-templates.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Sign in required." });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }

  let user;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Sign in required." });
    user = await userRes.json();
  } catch (e) {
    return res.status(401).json({ error: "Sign in required." });
  }

  if (!emailEnabled()) {
    return res.status(200).json({ sent: false, reason: "email_disabled" });
  }

  // Best-effort name lookup for the greeting (non-fatal).
  let name = "";
  try {
    const profRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=name`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (profRes.ok) {
      const rows = await profRes.json();
      // Strip < > — name is user-controlled and lands raw in HTML email bodies.
      if (rows[0] && rows[0].name) name = String(rows[0].name).replace(/[<>]/g, "").slice(0, 120);
    }
  } catch (e) { /* non-fatal */ }

  const tpl = passwordChangedTemplate({ name });
  // Dedupe by the exact second — collapses double-submits / network retries
  // but lets a genuine "user changed it twice in a row" send twice.
  const dedupeKey = "password_changed_" + Math.floor(Date.now() / 1000);
  const sent = await sendEmail({
    userId:    user.id,
    to:        user.email,
    template:  "password_changed",
    dedupeKey: dedupeKey,
    subject:   tpl.subject,
    html:      tpl.html,
    text:      tpl.text,
    marketing: false,
  });

  return res.status(200).json({ sent });
}
