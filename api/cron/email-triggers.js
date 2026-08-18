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

// Free trial length in days. Mirrored in api/chat.js (the generation gate)
// and index.html (the client-side lock) — keep all three in sync. This file
// needs it so lifecycle mail can avoid pitching actions the API will refuse.
const TRIAL_DAYS = 14;

function daysSince(isoDate) {
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
}

// ISO 8601 week number. [WEEK-START] No longer the weekly_reset suffix (that
// moved to the per-user planning-week key); still the dedupe suffix for the
// genuinely global weekly sends — inactive_7d and sunday_reset.
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

// [TRIAL-AWARE-EMAIL] comp columns ride along so this cron can compute the
// SAME notion of "trial expired" that api/chat.js gates generation on. A
// comped tester is NOT expired (chat.js bypasses the day cap while the comp
// is live), so suppressing their mail would be wrong.
async function fetchCredits(userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/credits?user_id=eq.${userId}`
      + `&select=plan,reset_at,comp_weekly_credits,comp_expires_at`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

// [TRIAL-AWARE-EMAIL] The single definition of "past the free trial",
// shared by both cron passes. Mirror of the generation gate in api/chat.js
// — kept in the same shape on purpose: the moment these two drift we start
// mailing people about actions the API refuses. A live comp bypasses the
// day cap there, so it must bypass "expired" here too.
function isTrialExpired(user, credit) {
  if (PAID_PLANS.includes(credit ? credit.plan : null)) return false;
  const compExpiresMs = credit && credit.comp_expires_at
    ? Date.parse(credit.comp_expires_at) : NaN;
  const compActive = !Number.isNaN(compExpiresMs)
    && compExpiresMs > Date.now()
    && credit.comp_weekly_credits != null;
  if (compActive) return false;
  const days = daysSince(user.created_at);
  return days !== null && days >= TRIAL_DAYS;
}

// [WEEK-START] Returns { name, weekStartDay }. weekStartDay (0=Sun..6=Sat) is
// what the weekly "plan your week" email is anchored to — see the trigger
// below for why it no longer rides the credit cycle.
async function fetchProfileForEmail(userId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=name,week_start_day`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) return { name: "", weekStartDay: 0 };
    const rows = await res.json();
    // Strip angle brackets: `name` is user-controlled and gets interpolated
    // raw into HTML email bodies. Removing < > neutralizes tag injection
    // while keeping the plaintext variants clean (no entity artifacts).
    const name = ((rows[0] && rows[0].name) || "").replace(/[<>]/g, "").slice(0, 120);
    const raw = rows[0] && rows[0].week_start_day;
    const n = parseInt(raw, 10);
    return { name, weekStartDay: (Number.isInteger(n) && n >= 0 && n <= 6) ? n : 0 };
  } catch (e) { return { name: "", weekStartDay: 0 }; }
}

// UTC start-of-planning-week date (YYYY-MM-DD) for the week containing `ms`.
// Mirrors weekStartUTC in api/_lib/plan-history.js — used here purely as the
// weekly email's dedupe key, so one send per planning week per user.
function weekStartKeyUTC(ms, weekStartDay) {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - weekStartDay + 7) % 7));
  return d.toISOString().slice(0, 10);
}

// Whether this user has EVER generated a plan. Used by the phase1-no-plan
// trigger to skip users who've already cleared the "first plan" hurdle.
//
// [EVER-GENERATED-FIX] This used to check `plans` alone, which is wrong:
// `plans` holds only the user's CURRENT plan (one row per user), and at the
// time it was ALSO deleted once the plan expired. So a user who generated a
// plan weeks ago and let it lapse read as "never generated" and became
// eligible for a "you haven't made your first plan yet" email that is plainly
// false to them. Production bore this out: 13 distinct users had fired
// `plan_generated`, but `plans` held only 8 rows.
//
// [WEEK-START] Expired plans are no longer deleted (the client keeps them as
// "last week's plan"), so `plans` rows now persist. The plan_history check
// below stays regardless: rows predating that change are still missing, and
// history remains the durable record.
//
// `plan_history` is the durable record, so it is the authority here. We
// still check `plans` first because it is the cheaper hit for active users
// and short-circuits the common case.
//
// Fails CLOSED (returns true = "has generated" = suppress the email) when
// both lookups error, so a transient blip can't produce a wrong send.
async function userHasEverGeneratedPlan(userId) {
  const headers = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/plans?user_id=eq.${userId}&select=user_id&limit=1`,
      { headers }
    );
    if (res.ok) {
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) return true;
    }
    const histRes = await fetch(
      `${SUPABASE_URL}/rest/v1/plan_history?user_id=eq.${userId}&select=user_id&limit=1`,
      { headers }
    );
    if (!histRes.ok) return true; // fail closed — don't risk a false "no plan yet"
    const histRows = await histRes.json();
    return Array.isArray(histRows) && histRows.length > 0;
  } catch (e) { return true; }
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

// Tomorrow's scheduled cards from the user's active plan, for the
// evening-before reminder. Matches each card's weekday label
// ("Day N - Thu") against TOMORROW's weekday.
//
// Timezone note: the reminder cron runs 23:30 UTC, when every US zone is
// still on the same calendar date as UTC (6:30 PM CT / 4:30 PM PT /
// 7:30 PM ET), so getUTCDay()+1 is tomorrow for all US users. Known
// cliff: a UK/EU user is already past midnight at 23:30 UTC, so their
// "tomorrow" email describes a day that has started — revisit before
// opening international signups.
//
// Returns { cards, hasPlan }: hasPlan is false when there is no plan row
// or the plan expires before tomorrow — the Sunday reset email uses that
// to switch to the build-your-week variant.
const WEEKDAY_ABBRS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
async function fetchTomorrowsCards(userId) {
  const empty = { cards: [], hasPlan: false };
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/plans?user_id=eq.${userId}&select=cards,expires_at`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) return empty;
    const rows = await res.json();
    const plan = rows[0];
    if (!plan || !Array.isArray(plan.cards)) return empty;
    // Plan must still be active TOMORROW, not just now — a plan expiring
    // overnight has nothing valid to remind about.
    const tomorrowStart = new Date(); tomorrowStart.setUTCHours(24, 0, 0, 0);
    if (plan.expires_at && Date.parse(plan.expires_at) <= tomorrowStart.getTime()) return empty;
    const tomorrowAbbr = WEEKDAY_ABBRS[(new Date().getUTCDay() + 1) % 7];
    const cards = plan.cards.filter(function (co) {
      if (!co || !co.title) return false;
      const parts = String(co.day || "").split(" - ");
      const abbr  = (parts[1] || parts[0] || "").trim().slice(0, 3).toLowerCase();
      return abbr === tomorrowAbbr;
    });
    return { cards, hasPlan: true };
  } catch (e) { return empty; }
}

// True when the user already received any OTHER lifecycle email today
// (trial sequence, welcome, inactivity, etc). The evening reminder yields
// to those — one conversion-critical email a day beats two nudges.
async function userGotOtherEmailToday(userId) {
  try {
    const todayISO = new Date().toISOString().slice(0, 10);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/email_sends?user_id=eq.${userId}&sent_at=gte.${todayISO}T00:00:00Z&select=template&limit=10`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) return false; // fail open: a fetch blip shouldn't kill the reminder
    const rows = await res.json();
    return Array.isArray(rows) && rows.some(r => r && r.template &&
      r.template !== "posting_reminder" && r.template !== "sunday_reset");
  } catch (e) { return false; }
}

// Per-user dispatch — figures out which (if any) trigger applies today.
async function processUser(user, todayIsSunday, weekKey) {
  const userId   = user.id;
  const email    = user.email;
  const days     = daysSince(user.created_at);
  if (!email || days === null) return;

  const credit  = await fetchCredits(userId);
  const plan    = credit ? credit.plan : null;
  // [WEEK-START] credits.reset_at is no longer read here — the weekly
  // reminder moved onto the planning-week anchor. Left out of scope rather
  // than kept unused; fetchCredits still selects it for the Loops sync below.
  const isPaid = PAID_PLANS.includes(plan);

  const trialExpired = isTrialExpired(user, credit);

  const { name, weekStartDay } = await fetchProfileForEmail(userId);
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

  // Weekly "plan your week" reminder — marketing, opt-out-able.
  //
  // [WEEK-START] Anchored to the creator's PLANNING week (profiles
  // .week_start_day), not the credit cycle.
  //
  // History: this was originally gated on calendar Mondays, then moved to
  // credits.reset_at because the credit cycle is per-user. But that cycle
  // drifts — the lazy reset in api/chat.js re-anchors reset_at to now()+7d on
  // the first generation after expiry, and api/stripe-webhook.js re-anchors
  // it again on subscribe — so the mail arrived on a different weekday every
  // cycle and moved when someone paid. Now that the plan itself starts and
  // ends on the creator's own anchor day, an email whose entire CTA is
  // "generate this week's plan" firing on a drifting Wednesday actively
  // fights the thing it is advertising.
  //
  // Fires on the creator's anchor day, deduped by that week's start date so
  // each planning week gets exactly one send no matter how many times the
  // daily cron runs. The days >= 7 floor keeps first-week users on the
  // welcome track.
  //
  // [TRIAL-AWARE-EMAIL] Suppressed once the trial has expired. This email's
  // whole CTA is "Generate this week's plan" — the exact action api/chat.js
  // answers with a 402 for expired free users. Sending it created a closed
  // loop: user clicks, gets blocked, gets the same mail next cycle. Paid and
  // comped users are unaffected; only expired free accounts are skipped.
  // (What these users SHOULD get is an upgrade-framed win-back — that needs
  // new copy, so it is deliberately not bolted on here.)
  // Today IS the creator's week-start day (cron runs daily at 14:00 UTC).
  const isPlanningWeekStart = new Date().getUTCDay() === weekStartDay;
  if (!trialExpired && days >= 7 && isPlanningWeekStart) {
    const cycleKey = weekStartKeyUTC(Date.now(), weekStartDay);
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
  //
  // [OVERLAP-FIX] Upper bound was `<= 30`, which collided with the Tier 3
  // rule below (`>= 30`) on the exact day a user hit 30 days idle — that
  // user got BOTH win-back emails in the same cron run. Now `< 30`, so the
  // two tiers partition cleanly.
  //
  // [KNOWN-ISSUE — needs a copy decision, deliberately not fixed here]
  // The `days >= 14` floor means that for a FREE user this email only ever
  // fires after the trial has expired. Its subject is "Your VIRL plan is
  // waiting" and its CTA points at generation — which api/chat.js refuses
  // with a 402 for exactly these users. Suppressing it was the other option
  // and was rejected: this is currently the ONLY recurring touchpoint the
  // lapsed free base receives, so silencing it would remove the last
  // conversion surface rather than fix it. The real fix is an
  // upgrade-framed variant for expired trials (new copy → Lauren's call).
  if (lastSignInDays !== null && lastSignInDays >= 7 && lastSignInDays < 30 && days >= 14) {
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

  // NOTE: the posting reminder and Sunday log nudge moved to the evening
  // pass (processReminderUser, job=reminders cron at 23:30 UTC). The
  // Sunday-morning log nudge is retired — its content folded into the
  // Sunday-evening reset email.
}

// Evening pass (23:30 UTC ≈ 6:30 PM CT) — the ONLY thing the
// job=reminders cron invocation runs. Two emails, mutually exclusive:
//
//   Mon–Sat: "tomorrow's posts" reminder, only when tomorrow has cards.
//   Sunday:  the Sunday reset — closes last week (unlogged results) and
//            opens next week (Monday's cards, or build-your-week when no
//            active plan covers next week).
//
// Guardrails (see rollout plan): yields to any other lifecycle email sent
// the same day; deduped on the TARGET date (a re-run can't double-send);
// rest days send nothing; marketing/opt-out-able.
// Success metric: post_marked events within 24h of a send — join
// email_sends (template posting_reminder / sunday_reset) to events.
async function processReminderUser(user, todayIsSunday, weekKey) {
  const userId = user.id;
  const email  = user.email;
  if (!email) return;

  const { cards: tomorrowCards, hasPlan } = await fetchTomorrowsCards(userId);

  // [TRIAL-AWARE-EMAIL] This pass had NO trial check at all, which made the
  // Sunday reset the one email that mailed dead free accounts forever. The
  // send condition below fires when `!hasPlan` — and an expired free user
  // can never have a plan, because generating one is exactly what
  // api/chat.js answers with a 402. So every expired trial got the
  // build-your-week variant ("60 seconds tonight sets up your whole week")
  // every single Sunday, pitching the one action it cannot take.
  //
  // The guard is `expired AND no active plan`, not a blanket expiry skip: a
  // free user who generated on day 13 still has a live 7-day plan for a
  // week after the trial ends, and reminders about cards already sitting in
  // their app are honest and useful. What we refuse to send is the pitch to
  // build something new. Once that last plan lapses, this pass goes quiet —
  // win-back for lapsed accounts belongs to the lifecycle pass, not here.
  const credit = await fetchCredits(userId);
  if (isTrialExpired(user, credit) && !hasPlan) return;

  const unlogged = todayIsSunday ? await fetchUnloggedCount(userId) : 0;

  if (todayIsSunday) {
    // Sunday reset sends unless there is truly nothing to say: a plan
    // exists, Monday is a rest day, and nothing needs logging.
    if (!hasPlan || tomorrowCards.length > 0 || unlogged > 0) {
      if (await userGotOtherEmailToday(userId)) return;
      const { name } = await fetchProfileForEmail(userId);
      const tpl = T.sundayReset({ name, unloggedCount: unlogged, cards: tomorrowCards, hasPlan, unsubscribeToken: makeUnsubToken(userId) });
      await sendEmail({
        userId, to: email, template: "sunday_reset", dedupeKey: `sunday_reset_${weekKey}`,
        subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: true,
      });
    }
    return;
  }

  if (tomorrowCards.length === 0) return; // rest day or no plan: silence
  if (await userGotOtherEmailToday(userId)) return;
  const { name } = await fetchProfileForEmail(userId);
  const targetDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const tpl = T.postingReminder({ name, cards: tomorrowCards, unsubscribeToken: makeUnsubToken(userId) });
  await sendEmail({
    userId, to: email, template: "posting_reminder", dedupeKey: `posting_reminder_${targetDate}`,
    subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: true,
  });
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
  // Two cron entries hit this endpoint (vercel.json):
  //   14:00 UTC (no query)      → full lifecycle pass (everything but reminders)
  //   23:30 UTC ?job=reminders  → evening reminder pass ONLY
  // The gate is load-bearing: without it the evening cron would re-run
  // every lifecycle trigger and lean on each one's dedupe to not
  // double-send. Never run both passes in one invocation.
  const job = (req.query && req.query.job) || "";
  const remindersOnly = job === "reminders";
  let processed = 0, errors = 0;
  let page = 1;
  const perPage = 200;

  try {
    while (true) {
      const batch = await fetchUsersBatch(page, perPage);
      if (!batch.length) break;
      for (const u of batch) {
        try {
          if (remindersOnly) await processReminderUser(u, todayIsSunday, weekKey);
          else await processUser(u, todayIsSunday, weekKey);
          processed++;
        }
        catch (e) { errors++; console.error("[cron/email] user error", u.id, e.message); }
      }
      if (batch.length < perPage) break;
      page++;
    }
  } catch (e) {
    console.error("[cron/email] fatal", e.message);
    return res.status(500).json({ ok: false, error: e.message, processed, errors, job });
  }

  return res.status(200).json({ ok: true, processed, errors, todayIsMonday, todayIsSunday, job: job || "lifecycle" });
}
