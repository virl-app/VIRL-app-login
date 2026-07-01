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
// [PREMIUM 7] thirtyDayMilestone is fired here (not the app) because
// it's a calendar-day check that has to run whether or not the user
// is currently online.
import { sendLoopsEvent, sendLoopsEventOnce, updateLoopsContact, loopsPlanValue, computeDaysIntoTrial } from "../_lib/loops.js";
import { cronAuthorized } from "../_lib/cron-auth.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// [EMAIL-CUTOVER] When true, this cron skips the welcome safety-net AND the
// trial day 7/11/13/expired Resend sends. Both are now handled by Loops
// (welcome via the `signup_welcome` event from /api/email/welcome; the
// trial sequence via Loops audience filters keyed on the contact's
// signupAt property — see migrations/003-email-preferences-schema.sql and
// Claude Cowork's Loops setup). Other cron sends (weekly_reset,
// phase1_no_plan_24h, inactive_7d, etc.) are NOT yet migrated and continue
// to fire via Resend regardless of this flag.
const EMAIL_VIA_LOOPS      = process.env.EMAIL_VIA_LOOPS === "true";

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

async function fetchCredits(userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/credits?user_id=eq.${userId}&select=plan,reset_at`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
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

// Whether a plans row exists for this user (regardless of expires_at).
// Used by the phase1-no-plan trigger to skip users who've already gotten
// past the "first plan" hurdle.
async function userHasEverGeneratedPlan(userId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/plans?user_id=eq.${userId}&select=user_id&limit=1`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) { return false; }
}

// Pulls the user's current plan (cards + expires_at) plus their
// user_data.results array so the Sunday log nudge can compute how many
// cards still need results logged.
async function fetchUnloggedCount(userId) {
  try {
    const [planRes, dataRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/plans?user_id=eq.${userId}&select=cards,expires_at`,
        { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${userId}&select=results`,
        { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
      ),
    ]);
    if (!planRes.ok || !dataRes.ok) return 0;
    const planRows = await planRes.json();
    const dataRows = await dataRes.json();
    const plan = planRows[0];
    if (!plan || !Array.isArray(plan.cards)) return 0;
    if (plan.expires_at && Date.parse(plan.expires_at) <= Date.now()) return 0;
    const results = (dataRows[0] && Array.isArray(dataRows[0].results)) ? dataRows[0].results : [];
    const loggedIds = new Set(results.map(r => r && r.id).filter(Boolean));
    let unlogged = 0;
    for (const c of plan.cards) {
      if (!c) continue;
      const cardId = (c.title || "") + (c.day || "");
      if (!loggedIds.has(cardId)) unlogged++;
    }
    return unlogged;
  } catch (e) { return 0; }
}

// Per-user dispatch — figures out which (if any) trigger applies today.
async function processUser(user, todayIsSunday, weekKey) {
  const userId   = user.id;
  const email    = user.email;
  const days     = daysSince(user.created_at);
  if (!email || days === null) return;

  const credit  = await fetchCredits(userId);
  const plan    = credit ? credit.plan : null;
  const resetAt = credit ? credit.reset_at : null;
  const isPaid = PAID_PLANS.includes(plan);
  const name = await fetchProfileName(userId);
  const unsubToken = makeUnsubToken(userId);
  const lastSignInDays = daysSince(user.last_sign_in_at);

  // [LOOPS-PLAN] Periodic contact-property sync. Two jobs here:
  //   1. Keep `plan` non-blank and current — free/trial users (whose plan
  //      was never pushed at signup before this change, or who downgraded
  //      back to free) land at "free"; paid/cancelled tiers pass through.
  //   2. Recompute `daysIntoTrial` daily so the trial audience guard
  //      advances over time instead of freezing at the signup-day value.
  // Loops stores a static number, so only a re-PUT moves it — this daily
  // cron is that re-PUT. Awaited (paces us under Loops's rate ceiling) but
  // failure-tolerant: updateLoopsContact logs and swallows its own errors
  // and never throws, so a Loops blip can't abort the user's email
  // triggers below.
  await updateLoopsContact({
    userId, email,
    properties: {
      plan:          loopsPlanValue(plan),
      daysIntoTrial: computeDaysIntoTrial(user.created_at),
      signupAt:      user.created_at || undefined,
    },
  });

  // Welcome safety-net: catches anyone the inline /api/email/welcome call
  // missed (network errors, function cold-start timeouts, etc).
  // The email_sends unique constraint makes the inline + cron pair safe.
  // [STABILITY] Was gated on !EMAIL_VIA_LOOPS — removed. Even after the
  // Loops cutover the cron safety-net stays useful: if Cowork's Loops
  // automation breaks (mis-configured, rate-limited, dashboard glitch),
  // the cron's Resend send still arrives.
  // [CROSS-PATH-DEDUPE] The Loops inline path now pre-claims the same
  // (template=welcome, dedupe_key=welcome) slot before firing the Loops
  // event (see api/email/welcome.js), so the cron's claimSend here fails
  // when Loops already delivered — no double welcome.
  if (days <= 7) {
    const tpl = T.welcome({ name });
    await sendEmail({
      userId, to: email, template: "welcome", dedupeKey: "welcome",
      subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: false,
    });
  }

  // Trial reminders apply to free-plan users only.
  // [EMAIL-CUTOVER] When EMAIL_VIA_LOOPS=true, the entire trial sequence is
  // skipped here. Loops handles trial day 7/11/13/expired via audience
  // filters keyed on `signupAt` (set during /api/email/welcome's
  // updateLoopsContact call) — no backend cron event needed.
  // [STABILITY] days bounds changed from === to >= so a missed cron day
  // self-heals on the next run. email_sends dedupe (per template+key)
  // prevents resends for users who already got the email at the right
  // moment; users who would have missed the email entirely now catch up.
  if (!EMAIL_VIA_LOOPS && !isPaid) {
    if (days >= 7) {
      const tpl = T.trialDay7({ name, unsubscribeToken: unsubToken });
      await sendEmail({
        userId, to: email, template: "trial_day_7", dedupeKey: "trial_day_7",
        subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: true,
      });
    }
    if (days >= 11) {
      const tpl = T.trialDay11({ name, unsubscribeToken: unsubToken });
      await sendEmail({
        userId, to: email, template: "trial_day_11", dedupeKey: "trial_day_11",
        subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: false,
      });
    }
    if (days >= 13) {
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

  // Weekly credit-reset reminder — marketing, opt-out-able. Anchored to the
  // user's OWN reset cycle (credits.reset_at), NOT a global Monday.
  //
  // Source of truth: credits reset on a per-user 7-day window stored in
  // credits.reset_at. handle_new_user seeds the first window, and the lazy
  // reset in api/chat.js re-anchors reset_at to now()+7d on the first
  // generation after the window expires — so an active user's reset day
  // drifts to whatever day/time they generate, and is almost never a
  // calendar Monday. Gating on Mondays therefore fired the reminder on the
  // wrong day (a day early, every week) for anyone off the Monday cadence.
  //
  // We now fire once the user's window has actually rolled over
  // (now >= reset_at), so the email lands on their real reset day. Deduped
  // per cycle by the reset_at date: each new cycle gets a fresh reset_at
  // (different date) → exactly one send; a frozen reset_at (a user who hasn't
  // generated since expiry) keeps the same key → no resend on later runs.
  // The days >= 7 floor keeps first-week users on the welcome track.
  const resetMs = resetAt ? Date.parse(resetAt) : NaN;
  if (days >= 7 && !Number.isNaN(resetMs) && Date.now() >= resetMs) {
    const cycleKey = resetAt.slice(0, 10); // YYYY-MM-DD of this cycle's reset
    const tpl = T.weeklyReset({ name, unsubscribeToken: unsubToken });
    await sendEmail({
      userId, to: email, template: "weekly_reset", dedupeKey: `weekly_reset_${cycleKey}`,
      subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: true,
    });
  }

  // [PREMIUM 7] Day-30 milestone for paid users. Fires once per user.
  // Email content + property merging happen in Loops; we just trip the
  // event with the firstName so the template can address them.
  // [LOOPS-DEDUPE] Audit finding #12. Previously relied on the comment
  // "Loops dedupes a contact's events" — that's only true if Cowork
  // configured per-contact dedupe in the dashboard, which we can't
  // verify from here. Adding email_sends-side claim is belt-and-braces;
  // also lets the gate change from days === 30 to days >= 30 self-heal
  // (a missed cron day no longer skips the milestone — claim prevents
  // a second fire).
  if (isPaid && days >= 30) {
    await sendLoopsEventOnce({
      userId, email, eventName: "thirtyDayMilestone",
      properties: { firstName: name || "" },
      dedupeKey: "thirtyDayMilestone",
    });
  }

  // Tier 2 — Phase 1 saved but no plan after 24h. Account is between
  // 1 and 7 days old, profile name is set (Phase 1 done), and no plans
  // row exists. One-time per user (dedupeKey: phase1_no_plan_24h).
  if (days >= 1 && days <= 7 && name) {
    const hasPlan = await userHasEverGeneratedPlan(userId);
    if (!hasPlan) {
      const tpl = T.phase1NoPlan({ name, unsubscribeToken: unsubToken });
      await sendEmail({
        userId, to: email, template: "phase1_no_plan_24h", dedupeKey: "phase1_no_plan_24h",
        subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: true,
      });
    }
  }

  // Tier 2 — 7-day inactivity re-engagement. Last sign-in was 7-30 days
  // ago and the account is past the trial-warning windows. Weekly dedupe
  // so we don't send daily.
  if (lastSignInDays !== null && lastSignInDays >= 7 && lastSignInDays <= 30 && days >= 14) {
    const tpl = T.inactive7Day({ name, unsubscribeToken: unsubToken });
    await sendEmail({
      userId, to: email, template: "inactive_7d", dedupeKey: `inactive_7d_${weekKey}`,
      subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: true,
    });
  }

  // Tier 3 — 30-day inactivity (deeper churn). Last sign-in 30+ days ago.
  // Monthly dedupe key (year-month) so a long-dormant user gets at most
  // one of these per month rather than weekly noise.
  if (lastSignInDays !== null && lastSignInDays >= 30) {
    const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM
    const tpl = T.inactive30Day({ name, unsubscribeToken: unsubToken });
    await sendEmail({
      userId, to: email, template: "inactive_30d", dedupeKey: `inactive_30d_${monthKey}`,
      subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: true,
    });
  }

  // Tier 2 — Sunday batch-log nudge. Today is Sunday, the user has a
  // current plan, and at least one card hasn't been logged. Weekly dedupe
  // so a re-run on the same Sunday is a no-op.
  if (todayIsSunday) {
    const unlogged = await fetchUnloggedCount(userId);
    if (unlogged > 0) {
      const tpl = T.sundayLogNudge({ name, unloggedCount: unlogged, unsubscribeToken: unsubToken });
      await sendEmail({
        userId, to: email, template: "sunday_log", dedupeKey: `sunday_log_${weekKey}`,
        subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: true,
      });
    }
  }
}

export default async function handler(req, res) {
  // Auth: Vercel cron sends `Authorization: Bearer ${CRON_SECRET}`. Reject
  // any caller without the right secret so the endpoint isn't externally
  // hittable. cronAuthorized logs the rejection reason (missing secret vs.
  // bearer mismatch) so a misconfigured CRON_SECRET doesn't fail silently.
  if (!cronAuthorized(req, "email-triggers")) {
    return res.status(401).json({ error: "unauthorized" });
  }

  if (!emailEnabled()) {
    return res.status(200).json({ ok: true, skipped: "email_disabled" });
  }

  const now = new Date();
  const todayIsMonday = now.getUTCDay() === 1;
  const todayIsSunday = now.getUTCDay() === 0;
  const weekKey       = isoYearWeek(now);
  let processed = 0, errors = 0;
  let page = 1;
  const perPage = 200;

  try {
    while (true) {
      const batch = await fetchUsersBatch(page, perPage);
      if (!batch.length) break;
      for (const u of batch) {
        try { await processUser(u, todayIsSunday, weekKey); processed++; }
        catch (e) { errors++; console.error("[cron/email] user error", u.id, e.message); }
      }
      if (batch.length < perPage) break;
      page++;
    }
  } catch (e) {
    console.error("[cron/email] fatal", e.message);
    return res.status(500).json({ ok: false, error: e.message, processed, errors });
  }

  return res.status(200).json({ ok: true, processed, errors, todayIsMonday, todayIsSunday });
}
