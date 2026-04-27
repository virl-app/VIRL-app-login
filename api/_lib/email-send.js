// Shared email send wrapper used by all triggers (cron + inline).
//
// Fail-open philosophy: a missing Resend config or a failed send must NEVER
// crash the calling endpoint. Triggers log + return false; callers continue.
//
// Idempotency lives in the email_sends table. Every send is keyed by
// (user_id, template, dedupe_key) with a unique constraint — a duplicate
// attempt resolves to "already sent, skip" instead of a second mail.

import { Resend } from "resend";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY       = process.env.RESEND_API_KEY;
const EMAIL_FROM           = process.env.EMAIL_FROM || "VIRL <hello@govirl.ai>";

function emailEnabled() {
  return !!(RESEND_API_KEY && SUPABASE_URL && SUPABASE_SERVICE_KEY);
}

// Insert a row into email_sends. Returns true if inserted (we should send),
// false if the unique constraint fired (already sent — skip).
async function claimSend(userId, template, dedupeKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/email_sends`, {
    method: "POST",
    headers: {
      "apikey":        SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type":  "application/json",
      "Prefer":        "return=representation",
    },
    body: JSON.stringify({
      user_id:    userId,
      template:   template,
      dedupe_key: dedupeKey,
    }),
  });
  // 201 Created → fresh send. 409 Conflict → already in table → skip.
  if (res.status === 201) return true;
  if (res.status === 409) return false;
  // Any other status — log and skip to avoid duplicate mails on transient errors
  const body = await res.text().catch(() => "");
  console.warn(`[email] claimSend unexpected status ${res.status}:`, body);
  return false;
}

async function recordResendId(userId, template, dedupeKey, resendId) {
  if (!resendId) return;
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/email_sends?user_id=eq.${userId}&template=eq.${encodeURIComponent(template)}&dedupe_key=eq.${encodeURIComponent(dedupeKey)}`,
      {
        method:  "PATCH",
        headers: {
          "apikey":        SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type":  "application/json",
          "Prefer":        "return=minimal",
        },
        body: JSON.stringify({ resend_id: resendId }),
      }
    );
  } catch (e) {
    // Non-fatal — we already inserted the row, the resend_id is just for audit.
  }
}

// Look up a marketing-opt-out preference. Defaults to opt-IN (false) so a
// missing row never blocks a send. Always returns false for transactional
// templates regardless of preference.
async function isMarketingOptedOut(userId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/email_preferences?user_id=eq.${userId}&select=marketing_opt_out`,
      {
        headers: {
          "apikey":        SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return !!(rows[0] && rows[0].marketing_opt_out);
  } catch (e) {
    return false;
  }
}

// Main entry point.
//
// opts: {
//   userId:     uuid (required)
//   to:         email address (required)
//   template:   short slug like "welcome" (required)
//   dedupeKey:  per-occurrence key (required) — see triggers map below
//   subject:    string
//   html:       string
//   text:       string
//   marketing:  boolean — if true, skips when marketing_opt_out
// }
export async function sendEmail(opts) {
  if (!emailEnabled()) {
    console.warn(`[email] skipped (${opts.template}) — Resend or Supabase env not configured`);
    return false;
  }

  if (opts.marketing && (await isMarketingOptedOut(opts.userId))) {
    console.log(`[email] skipped (${opts.template}) — user ${opts.userId} opted out of marketing`);
    return false;
  }

  const claimed = await claimSend(opts.userId, opts.template, opts.dedupeKey);
  if (!claimed) {
    // Already sent — silently skip. Re-running cron is therefore safe.
    return false;
  }

  try {
    const resend = new Resend(RESEND_API_KEY);
    const { data, error } = await resend.emails.send({
      from:    EMAIL_FROM,
      to:      [opts.to],
      subject: opts.subject,
      html:    opts.html,
      text:    opts.text,
    });
    if (error) {
      console.error(`[email] Resend error (${opts.template}):`, error.message || error);
      return false;
    }
    if (data && data.id) await recordResendId(opts.userId, opts.template, opts.dedupeKey, data.id);
    return true;
  } catch (e) {
    console.error(`[email] send threw (${opts.template}):`, e.message);
    return false;
  }
}

export { emailEnabled };
