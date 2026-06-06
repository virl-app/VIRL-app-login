import { Resend }            from "resend";
import { accountDeleted }    from "./_lib/email-templates.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY       = process.env.RESEND_API_KEY;
const EMAIL_FROM           = process.env.EMAIL_FROM || "VIRL <hello@govirl.ai>";

// Best-effort fetch of the user's email + name BEFORE we delete them.
// Once the auth row is gone we can't look it up anymore, so this has to
// happen at the top of the handler.
async function fetchEmailBeforeDelete(userId) {
  const out = { email: null, name: "" };
  if (!userId || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return out;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    if (r.ok) {
      const u = await r.json();
      out.email = u.email || null;
    }
  } catch (e) { /* non-fatal */ }
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=name`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (r.ok) {
      const rows = await r.json();
      if (rows[0] && rows[0].name) out.name = rows[0].name;
    }
  } catch (e) { /* non-fatal */ }
  return out;
}

// Last-email-ever send. Bypasses the email_sends dedupe table because the
// row gets cascaded away with the user_id; instead we send via Resend
// directly with the captured email. Failure is logged but never blocks
// the deletion flow — the account being closed is what the user asked for.
async function sendDeletionConfirmation(email, name) {
  if (!RESEND_API_KEY || !email) return;
  try {
    const tpl = accountDeleted({ name });
    const resend = new Resend(RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from:    EMAIL_FROM,
      to:      [email],
      subject: tpl.subject,
      html:    tpl.html,
      text:    tpl.text,
    });
    if (error) console.error("[delete-account] confirmation send failed:", error.message || error);
  } catch (e) {
    console.error("[delete-account] confirmation send threw:", e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  // [SECURITY] Verify the caller via Supabase Bearer token and derive the
  // userId from the verified token — NEVER trust a userId from the request
  // body. Without this gate any anonymous caller could POST another user's
  // UUID and delete that account (the endpoint uses SUPABASE_SERVICE_KEY,
  // which bypasses RLS). Same auth pattern as /api/chat, /api/email/welcome,
  // /api/loops-event.
  const authHeader = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!authHeader) return res.status(401).json({ error: 'Sign in required.' });

  let userId;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${authHeader}`, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Sign in required.' });
    const u = await userRes.json();
    userId = u.id;
  } catch (e) {
    return res.status(401).json({ error: 'Sign in required.' });
  }
  if (!userId) return res.status(401).json({ error: 'Sign in required.' });

  const headers = {
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'apikey': SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json',
  };

  // Capture contact info BEFORE deletion — once auth row is gone we can't
  // look it up anymore.
  const ctx = await fetchEmailBeforeDelete(userId);

  try {
    // 1. Delete the credits row (other tables cascade off auth.users).
    await fetch(`${SUPABASE_URL}/rest/v1/credits?user_id=eq.${userId}`, {
      method: 'DELETE', headers,
    });

    // 2. Delete the auth user — cascades user_data, plans, plan_history,
    //    feedback, usage_events via foreign keys.
    const deleteRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${userId}`,
      { method: 'DELETE', headers }
    );

    if (!deleteRes.ok) {
      const err = await deleteRes.json().catch(() => ({}));
      console.error('Auth delete error:', err);
      // Still return 200 — credits deleted, auth may already be gone.
    }

    // 3. Send the closure email last so it's the final thing the address
    //    ever receives from VIRL. Fire-and-forget; never blocks the response.
    if (ctx.email) sendDeletionConfirmation(ctx.email, ctx.name).catch(() => {});

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Delete account error:', err);
    return res.status(500).json({ error: err.message });
  }
}
