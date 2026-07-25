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
// [PERSONA] Sender-identity split (Task Group D3). Product/lifecycle mail sends
// AS VIRL (the strategist); milestone + founder mail sends AS Lauren, the
// founder, so the human moments feel human. Same address — only the display
// name differs — so replies still thread to the same inbox and deliverability
// isn't split across senders. Derived from EMAIL_FROM's address so a custom
// EMAIL_FROM env override keeps both senders on the same domain.
//   VIRL <hello@govirl.ai>  →  Lauren at VIRL <hello@govirl.ai>
const EMAIL_FROM_FOUNDER   = process.env.EMAIL_FROM_FOUNDER
  || `Lauren at VIRL <${(EMAIL_FROM.match(/<([^>]+)>/) || [, "hello@govirl.ai"])[1]}>`;

// [PERSONA] Templates written in Lauren's voice (see the classification header
// in email-templates.js). Everything not listed here sends as VIRL. These are
// the RUNTIME template slugs the callers pass to sendEmail (snake_case), NOT
// the camelCase builder names — the split is keyed on what actually arrives in
// opts.template. Keep in lockstep with the classification header: a template's
// voice and its sender must agree, or the From line contradicts the body.
export const FOUNDER_VOICE_TEMPLATES = new Set([
  "welcome",
  "subscription_welcome",
  "subscription_cancelled",
  "inactive_30d",
  "referral_rewarded",
  "referral_milestone",
]);

// Resolve the display sender for a template slug. Central so callers never
// hand-pick a From — they pass the template (which they already do) and the
// voice split is applied in one place.
export function senderFor(template) {
  return FOUNDER_VOICE_TEMPLATES.has(template) ? EMAIL_FROM_FOUNDER : EMAIL_FROM;
}

function emailEnabled() {
  return !!(RESEND_API_KEY && SUPABASE_URL && SUPABASE_SERVICE_KEY);
}

// Insert a row into email_sends. Returns true if inserted (we should send),
// false if the unique constraint fired (already sent — skip).
//
// Exported so the Loops helpers can reuse the same per-user-per-template-
// per-dedupe-key dedup table for one-shot Loops events (audit finding #12).
// Reusing the existing table beats spinning up a sibling loops_events_sends
// table for the same data shape.
export async function claimSend(userId, template, dedupeKey) {
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
export async function isMarketingOptedOut(userId) {
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

// [CREDIT-NUDGE] Pure read of email_sends — did (user, template, dedupeKey)
// already fire? Unlike claimSend it does NOT insert, so it can be used to
// *test* a prior send without consuming its dedupe slot (e.g. "did the
// exhausted nudge already go out this cycle, so suppress the low one?").
// Fail-open to false: a read blip just means we don't suppress, which is the
// safer direction for a one-shot nudge (worst case a redundant check, not a
// missed send).
export async function hasSent(userId, template, dedupeKey) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/email_sends?user_id=eq.${userId}`
      + `&template=eq.${encodeURIComponent(template)}`
      + `&dedupe_key=eq.${encodeURIComponent(dedupeKey)}&select=user_id&limit=1`,
      { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
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
      // [PERSONA] From line follows the template's voice. Explicit opts.from
      // still wins for any one-off caller that needs to override.
      from:    opts.from || senderFor(opts.template),
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
