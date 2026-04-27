// Admin-only email preview tool. Two modes per template:
//   ?template=<name>            → renders the HTML to the browser (no send)
//   ?template=<name>&send=1     → fires a real email to the admin via Resend,
//                                 bypassing the dedupe gate
//
// Auth: the same admin-bearer-token check used by /api/admin-stats.js.
// The token is accepted via either an Authorization header or `?t=`, so the
// admin tab can open the preview in a new browser tab without the header.

import { Resend }       from "resend";
import * as T           from "../_lib/email-templates.js";
import { makeUnsubToken } from "../_lib/unsub-token.js";

const ADMIN_EMAIL          = "laurenannedoty@gmail.com";
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY       = process.env.RESEND_API_KEY;
const EMAIL_FROM           = process.env.EMAIL_FROM || "VIRL <hello@govirl.ai>";

// Sample contexts so every template renders with realistic values.
// `uid` is the verified admin's auth.users.id, used for the unsub token so
// clicking the unsubscribe link in a preview send actually works end-to-end.
const TEMPLATES = {
  welcome:                (uid) => T.welcome({ name: "Lauren" }),
  trial_day_11:           (uid) => T.trialDay11({ name: "Lauren", unsubscribeToken: makeUnsubToken(uid) }),
  trial_day_13:           (uid) => T.trialDay13({ name: "Lauren", unsubscribeToken: makeUnsubToken(uid) }),
  trial_expired:          (uid) => T.trialExpired({ name: "Lauren", unsubscribeToken: makeUnsubToken(uid) }),
  subscription_welcome:   (uid) => T.subscriptionWelcome({ name: "Lauren", plan: "founding" }),
  payment_failed:         (uid) => T.paymentFailed({ name: "Lauren" }),
  subscription_cancelled: (uid) => T.subscriptionCancelled({ name: "Lauren" }),
  weekly_reset:           (uid) => T.weeklyReset({ name: "Lauren", unsubscribeToken: makeUnsubToken(uid) }),
};

async function verifyAdmin(token) {
  if (!token || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user || !user.email) return null;
    if (user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return null;
    return user;
  } catch (e) { return null; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function indexPage(token) {
  const t = encodeURIComponent(token);
  const rows = Object.keys(TEMPLATES).map(k => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-family:Helvetica,Arial,sans-serif;font-size:13px"><strong>${escapeHtml(k)}</strong></td>
      <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;text-align:right">
        <a href="?t=${t}&template=${k}" target="_blank" style="font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#2563EB;margin-right:14px;text-decoration:none">Preview HTML →</a>
        <a href="?t=${t}&template=${k}&send=1" style="font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#F43F5E;text-decoration:none">Send to me →</a>
      </td>
    </tr>`).join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>VIRL email preview</title></head>
<body style="margin:0;padding:48px 16px;background:#F8FAFC;color:#0F172A;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:680px;margin:0 auto;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:14px;overflow:hidden">
    <div style="padding:28px 32px 8px;border-bottom:1px solid #E2E8F0">
      <div style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:24px;color:#1F3A8A;letter-spacing:0.04em">VIRL</div>
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.25;margin-top:6px">Email preview</div>
    </div>
    <div style="padding:18px 32px;font-size:13px;color:#334155;line-height:1.6">
      <p style="margin:0 0 6px"><strong>Preview HTML</strong> renders the template in a new tab — no email is sent.</p>
      <p style="margin:0 0 6px"><strong>Send to me</strong> fires a real Resend send to ${escapeHtml(ADMIN_EMAIL)}, bypassing the dedupe gate. Subject is prefixed with <code>[TEST]</code>.</p>
    </div>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
  </div>
</body></html>`;
}

function sentPage(resendId) {
  return `<!doctype html>
<html><body style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:64px auto;padding:0 16px;color:#0F172A">
  <h2 style="font-family:Georgia,serif;font-style:italic;color:#1F3A8A">Sent.</h2>
  <p>Resend id: <code>${escapeHtml(resendId || "(none)")}</code></p>
  <p><a href="javascript:history.back()" style="color:#2563EB">Back</a></p>
</body></html>`;
}

export default async function handler(req, res) {
  const authHeader = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const token = (req.query && req.query.t) || authHeader || "";
  const admin = await verifyAdmin(token);
  if (!admin) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(401).send("<h2>Unauthorized</h2><p>Admin bearer token required.</p>");
  }

  const template = req.query && req.query.template;
  const send     = req.query && req.query.send === "1";

  if (!template) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(indexPage(token));
  }

  const builder = TEMPLATES[template];
  if (!builder) return res.status(400).send(`Unknown template: ${escapeHtml(template)}`);

  const tpl = builder(admin.id);

  if (send) {
    if (!RESEND_API_KEY) return res.status(500).send("RESEND_API_KEY not configured");
    try {
      const resend = new Resend(RESEND_API_KEY);
      const { data, error } = await resend.emails.send({
        from:    EMAIL_FROM,
        to:      [admin.email],
        subject: `[TEST] ${tpl.subject}`,
        html:    tpl.html,
        text:    tpl.text,
      });
      if (error) {
        const msg = error.message || JSON.stringify(error);
        return res.status(500).send(`<pre>Resend error: ${escapeHtml(msg)}</pre>`);
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(sentPage(data && data.id));
    } catch (e) {
      return res.status(500).send(`<pre>Send error: ${escapeHtml(e.message)}</pre>`);
    }
  }

  // Preview-only: render the template HTML directly.
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(tpl.html);
}
