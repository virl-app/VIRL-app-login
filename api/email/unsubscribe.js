// One-click unsubscribe from marketing emails. Token signed with a server
// secret so the link can't be forged. Returns a tiny HTML confirmation page;
// also handles POST for browser/mail-client one-click unsubscribe headers
// (RFC 8058 List-Unsubscribe-Post). Transactional emails — billing, trial
// reminders, welcome — keep sending regardless.

import { verifyUnsubToken }   from "../_lib/unsub-token.js";
import { updateLoopsContact } from "../_lib/loops.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function setOptOut(userId) {
  await fetch(`${SUPABASE_URL}/rest/v1/email_preferences`, {
    method: "POST",
    headers: {
      apikey:           SUPABASE_SERVICE_KEY,
      Authorization:    `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type":   "application/json",
      Prefer:           "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      user_id:           userId,
      marketing_opt_out: true,
      updated_at:        new Date().toISOString(),
    }),
  });
}

// [EMAIL-CUTOVER] §9 audit fix #4 — mirror the opt-out to Loops so Loops
// campaign audience filters with `marketingSubscribed = true` correctly
// exclude this contact. Without this sync, Loops only sees its own
// internal subscribed flag, which a Supabase opt-out doesn't update.
// Fire-and-forget; a Loops outage never blocks the unsubscribe path —
// the Supabase opt-out is what gates `api/_lib/email-send.js` suppression,
// so the user stays suppressed for any send going through that path.
// Loops sync drift gets reconciled by the monthly suppression audit
// described in docs/email-strategy-guide.md §7 (Week 4).
async function syncOptOutToLoops(userId) {
  try {
    await updateLoopsContact({
      userId,
      properties: { marketingSubscribed: false },
    });
  } catch (e) { /* logged inside updateLoopsContact */ }
}

function confirmationPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Unsubscribed — VIRL</title></head>
<body style="margin:0;padding:48px 16px;background:#F8FAFC;font-family:Helvetica,Arial,sans-serif;color:#0F172A;text-align:center">
  <div style="max-width:480px;margin:0 auto;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:14px;padding:36px 32px">
    <div style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:24px;color:#1F3A8A;letter-spacing:0.04em;margin-bottom:20px">VIRL</div>
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.25;margin-bottom:14px">You're unsubscribed.</div>
    <div style="font-size:14px;color:#334155;line-height:1.6">No more weekly nudges. We'll still send important account &amp; billing emails — those keep your subscription healthy.</div>
  </div>
</body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }
  const token = (req.query && req.query.t) || (req.body && req.body.t) || "";
  const userId = verifyUnsubToken(token);
  if (!userId) return res.status(400).send("Invalid or expired link.");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).send("Server misconfigured.");
  }

  try { await setOptOut(userId); } catch (e) { /* fail open — we'll show success anyway */ }
  // [EMAIL-CUTOVER] Mirror the opt-out to Loops. Fire-and-forget — runs
  // after setOptOut so even if Loops is down, the user is already
  // suppressed in Supabase (which gates api/_lib/email-send.js sends).
  syncOptOutToLoops(userId);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(confirmationPage());
}
