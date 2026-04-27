// Inline welcome email. Fired by the client on first SIGNED_IN. Idempotent
// thanks to the email_sends unique constraint — a second call from a token
// refresh, a different tab, or the cron safety-net is a no-op.

import { sendEmail, emailEnabled } from "../_lib/email-send.js";
import { welcome as welcomeTemplate } from "../_lib/email-templates.js";

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

  // Verify the bearer token against Supabase auth — same pattern as chat.js.
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
    // Silently no-op so a missing Resend config never breaks the sign-in flow.
    return res.status(200).json({ sent: false, reason: "email_disabled" });
  }

  // Pull display name from profile if present (best-effort, non-fatal).
  let name = "";
  try {
    const profRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=name`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (profRes.ok) {
      const rows = await profRes.json();
      if (rows[0] && rows[0].name) name = rows[0].name;
    }
  } catch (e) { /* non-fatal */ }

  const tpl = welcomeTemplate({ name });
  const sent = await sendEmail({
    userId:    user.id,
    to:        user.email,
    template:  "welcome",
    dedupeKey: "welcome",
    subject:   tpl.subject,
    html:      tpl.html,
    text:      tpl.text,
    marketing: false, // welcome is transactional
  });

  return res.status(200).json({ sent });
}
