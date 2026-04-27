// Daily Vercel cron — handles every time-based email trigger (trial day
// 11/13/14, weekly Monday reset, welcome safety-net). Inline / state-change
// triggers (welcome on sign-in, billing emails) live elsewhere; this job
// only covers triggers that key off "today is day N" or "today is Monday".
//
// Idempotency: every send goes through email_sends with a dedupe key
// derived from the trigger + a stable per-occurrence suffix, so re-runs
// (Vercel retries, manual replays) never duplicate mail.
//
// Auth: Vercel sends `Authorization: Bearer ${CRON_SECRET}` on scheduled
// invocations. Reject anything else.

import { sendEmail, emailEnabled } from "../_lib/email-send.js";
import { makeUnsubToken } from "../_lib/unsub-token.js";
import * as T from "../_lib/email-templates.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET          = process.env.CRON_SECRET;

const PAID_PLANS = ["founding", "pro", "standard"];
const DAY_MS     = 86400000;

function daysSince(isoDate) {
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
}

// ISO 8601 week number — used as the weekly_reset dedupe suffix so re-runs
// within the same Monday are no-ops but the next Monday gets a fresh slot.
function isoYearWeek(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Page through the auth.users admin endpoint plus per-user credit row.
// Auth admin returns email + created_at; we then need plan from credits.
async function fetchUsersBatch(page, perPage) {
  const url = `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`auth admin users ${res.status}`);
  const json = await res.json();
  return json.users || [];
}

async function fetchPlan(userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/credits?user_id=eq.${userId}&select=plan`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] ? rows[0].plan : null;
}

async function fetchProfileName(userId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=name`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) return "";
    const rows = await res.json();
    return (rows[0] && rows[0].name) || "";
  } catch (e) { return ""; }
}

// Per-user dispatch — figures out which (if any) trigger applies today.
async function processUser(user, todayIsMonday) {
  const userId   = user.id;
  const email    = user.email;
  const days     = daysSince(user.created_at);
  if (!email || days === null) return;

  const plan = await fetchPlan(userId);
  const isPaid = PAID_PLANS.includes(plan);
  const name = await fetchProfileName(userId);
  const unsubToken = makeUnsubToken(userId);

  // Welcome safety-net: catches anyone the inline /api/email/welcome call
  // missed (network errors, function cold-start timeouts, etc).
  // The email_sends unique constraint makes the inline + cron pair safe.
  if (days <= 7) {
    const tpl = T.welcome({ name });
    await sendEmail({
      userId, to: email, template: "welcome", dedupeKey: "welcome",
      subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: false,
    });
  }

  // Trial reminders apply to free-plan users only.
  if (!isPaid) {
    if (days === 11) {
      const tpl = T.trialDay11({ name, unsubscribeToken: unsubToken });
      await sendEmail({
        userId, to: email, template: "trial_day_11", dedupeKey: "trial_day_11",
        subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: false,
      });
    }
    if (days === 13) {
      const tpl = T.trialDay13({ name, unsubscribeToken: unsubToken });
      await sendEmail({
        userId, to: email, template: "trial_day_13", dedupeKey: "trial_day_13",
        subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: false,
      });
    }
    if (days >= 14) {
      const tpl = T.trialExpired({ name, unsubscribeToken: unsubToken });
      await sendEmail({
        userId, to: email, template: "trial_expired", dedupeKey: "trial_expired",
        subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: false,
      });
    }
  }

  // Weekly Monday reset — marketing, opt-out-able. Skip users still in the
  // first week (the welcome already covers them).
  if (todayIsMonday && days >= 7) {
    const tpl = T.weeklyReset({ name, unsubscribeToken: unsubToken });
    await sendEmail({
      userId, to: email, template: "weekly_reset", dedupeKey: `weekly_reset_${isoYearWeek(new Date())}`,
      subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: true,
    });
  }
}

export default async function handler(req, res) {
  // Auth: Vercel cron sends `Authorization: Bearer ${CRON_SECRET}`. Reject
  // any caller without the right secret so the endpoint isn't externally
  // hittable. (CRON_SECRET set as a Vercel env var.)
  const auth = req.headers.authorization || "";
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  if (!emailEnabled()) {
    return res.status(200).json({ ok: true, skipped: "email_disabled" });
  }

  const todayIsMonday = new Date().getUTCDay() === 1;
  let processed = 0, errors = 0;
  let page = 1;
  const perPage = 200;

  try {
    while (true) {
      const batch = await fetchUsersBatch(page, perPage);
      if (!batch.length) break;
      for (const u of batch) {
        try { await processUser(u, todayIsMonday); processed++; }
        catch (e) { errors++; console.error("[cron/email] user error", u.id, e.message); }
      }
      if (batch.length < perPage) break;
      page++;
    }
  } catch (e) {
    console.error("[cron/email] fatal", e.message);
    return res.status(500).json({ ok: false, error: e.message, processed, errors });
  }

  return res.status(200).json({ ok: true, processed, errors, todayIsMonday });
}
