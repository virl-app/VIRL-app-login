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

async function fetchProfileName(userId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=name`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) return "";
    const rows = await res.json();
    // Strip angle brackets: `name` is user-controlled and gets interpolated
    // raw into HTML email bodies. Removing < > neutralizes tag injection
    // while keeping the plaintext variants clean (no entity artifacts).
    return ((rows[0] && rows[0].name) || "").replace(/[<>]/g, "").slice(0, 120);
  } catch (e) { return ""; }
}

// Whether this user has EVER generated a plan. Used by the phase1-no-plan
// trigger to skip users who've already cleared the "first plan" hurdle.
//
// [EVER-GENERATED-FIX] This used to check `plans` alone, which is wrong:
// `plans` holds only the user's CURRENT plan (one row per user) and the app
// DELETES that row once the plan expires. So a user who generated a plan
// weeks ago and let it lapse read as "never generated" and became eligible
// for a "you haven't made your first plan yet" email that is plainly false
// to them. Production bears this out: 13 distinct users have fired
// `plan_generated`, but `plans` holds only 8 rows.
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

// [REMINDER-YIELD] The exact set of templates that may silence tonight's
// reminder, as an ALLOWLIST.
//
// This used to be a two-name denylist — "any template today except
// posting_reminder and sunday_reset" — which meant every email in the system
// outranked the reminder by default. A password-change confirmation, a
// referral payout, a renewal receipt, an admin trend alert: each one muted the
// single email that names the creator's actual posts for tomorrow. That is the
// "not driving action" complaint with a mechanism: the most specific,
// most actionable message in the program was the one that always lost.
//
// So the default flips. A template silences the reminder only if it is either
// conversion-critical (the trial window is closing and one clear ask beats
// two) or asks for THE SAME action, where two sends read as a duplicate:
//   phase1_no_plan_24h + the no-plan Sunday reset are both "go generate".
//   weekly_reset is the same ask on the same day.
// Everything else — including anything added later — coexists, which is the
// safe direction for a new template to default to.
export const REMINDER_YIELDS_TO = new Set([
  "welcome",             // day-zero inbox hygiene; the account is minutes old
  "trial_day_11",
  "trial_day_13",
  "trial_expired",
  "payment_failed",      // action needed on money beats action needed on content
  "phase1_no_plan_24h",  // same ask as the no-plan Sunday reset
  "weekly_reset",        // same ask, same day
]);

// True when the user already received an email today that outranks tonight's
// reminder. See REMINDER_YIELDS_TO for what counts and why.
//
// Exported for scripts/check-email-program.mjs, which drives it against a
// stubbed fetch. Asserting on the Set alone would only restate the constant;
// the regression that matters is this predicate reverting to "anything except
// the two reminder slugs", and only calling it can catch that.
export async function userGotOtherEmailToday(userId) {
  try {
    const todayISO = new Date().toISOString().slice(0, 10);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/email_sends?user_id=eq.${userId}&sent_at=gte.${todayISO}T00:00:00Z&select=template&limit=10`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) return false; // fail open: a fetch blip shouldn't kill the reminder
    const rows = await res.json();
    return Array.isArray(rows) && rows.some(r => r && r.template &&
      REMINDER_YIELDS_TO.has(r.template));
  } catch (e) { return false; }
}

// [TRIAL-SUPERSESSION] Exactly one trial email is a candidate on any given
// day: the latest milestone the account has reached.
//
// The four gates used to be independent `days >= N` checks, which is correct
// on the happy path (each milestone claims its dedupe slot the day it lands,
// so later runs no-op) and wrong in every recovery case. Any account that
// arrives at day 14+ with none of the four claimed — signed up before the
// sequence existed, EMAIL_VIA_LOOPS flipped true then back to false, a cron
// outage longer than the trial — matched all four in a single pass and got the
// whole sequence at once. Dedupe prevents RESENDS; it does nothing about four
// simultaneous FIRST sends. The reader gets "you're halfway through your free
// trial", "3 days left", "tomorrow's your last day", and "your trial has
// ended" in one delivery.
//
// Supersession makes that unreachable rather than unlikely: day 20 resolves to
// trial_expired and the three obsolete notes are never candidates at all. On
// the happy path the behavior is byte-identical — day 7 resolves to day 7, day
// 11 to day 11 — so the drip is unchanged for everyone it was already right
// for.
export function trialMilestone(days) {
  if (days >= 14) return { template: "trial_expired", dedupeKey: "trial_expired", marketing: false };
  if (days >= 13) return { template: "trial_day_13",  dedupeKey: "trial_day_13",  marketing: false };
  if (days >= 11) return { template: "trial_day_11",  dedupeKey: "trial_day_11",  marketing: false };
  if (days >= 7)  return { template: "trial_day_7",   dedupeKey: "trial_day_7",   marketing: true  };
  return null;
}

// [ONE-A-DAY] The lifecycle pass's decision, as a pure function.
//
// Returns every email this user is eligible for today, highest priority first.
// The caller sends the first one that actually claims and stops. Two things
// this shape buys that a straight-line series of `if (…) await sendEmail(…)`
// blocks could not:
//
//   1. A cap that cannot be bypassed by adding a trigger. The old body sent
//      each eligible email unconditionally, so a single run could deliver
//      trial_day_7 + weekly_reset + inactive_7d + phase1_no_plan_24h to one
//      inbox — and the fix for that, in the old shape, was a `sent` flag that
//      every future trigger has to remember to check. Here the cap is the
//      control flow.
//   2. Tests. The ordering and the eligibility windows are the part that
//      breaks, and they are now checkable without Supabase, Resend, or a clock
//      — see scripts/check-email-program.mjs.
//
// Priority is by what the reader most needs to know today, not by trigger age:
//   welcome              — the account is new; nothing outranks orientation.
//   phase1_no_plan_24h   — they have a profile and no plan. Activation is the
//                          only thing that matters and it outranks a mid-trial
//                          check-in on the one day (day 7) the two collide.
//   trial milestone      — the conversion window.
//   thirty_day_milestone — a once-ever celebration for paid users.
//   weekly_reset         — recurring nudge for active accounts.
//   inactive_7d/_30d     — win-back, the least time-sensitive thing here.
//
// `requiresNoPlan` defers an extra round trip: the caller only asks Supabase
// whether a plan has ever existed if the walk actually reaches that candidate.
export function lifecycleCandidates(ctx) {
  const { days, isPaid, trialExpired, viaLoops, hasName,
          resetAt, lastSignInDays, nowMs, weekKey, monthKey } = ctx;
  const out = [];

  if (days <= 7) {
    out.push({ template: "welcome", dedupeKey: "welcome", marketing: false });
  }

  if (hasName && days >= 1 && days <= 7) {
    out.push({ template: "phase1_no_plan_24h", dedupeKey: "phase1_no_plan_24h",
               marketing: true, requiresNoPlan: true });
  }

  if (!viaLoops && !isPaid) {
    const m = trialMilestone(days);
    if (m) out.push(m);
  }

  if (isPaid && days >= 30) {
    out.push({ template: "thirtyDayMilestone", dedupeKey: "thirtyDayMilestone",
               loopsEvent: true });
  }

  const resetMs = resetAt ? Date.parse(resetAt) : NaN;
  if (!trialExpired && days >= 7 && !Number.isNaN(resetMs) && nowMs >= resetMs) {
    out.push({ template: "weekly_reset", dedupeKey: `weekly_reset_${resetAt.slice(0, 10)}`,
               marketing: true });
  }

  if (lastSignInDays !== null && lastSignInDays >= 7 && lastSignInDays < 30 && days >= 14) {
    out.push({ template: "inactive_7d", dedupeKey: `inactive_7d_${weekKey}`, marketing: true });
  }

  if (lastSignInDays !== null && lastSignInDays >= 30) {
    out.push({ template: "inactive_30d", dedupeKey: `inactive_30d_${monthKey}`, marketing: true });
  }

  return out;
}

// Per-user dispatch for the lifecycle pass. Sends AT MOST ONE email per run
// — see lifecycleCandidates for the ordering and why the cap lives in the
// control flow rather than in a flag each trigger has to remember to check.
async function processUser(user, todayIsSunday, weekKey) {
  const userId   = user.id;
  const email    = user.email;
  const days     = daysSince(user.created_at);
  if (!email || days === null) return;

  const credit  = await fetchCredits(userId);
  const plan    = credit ? credit.plan : null;
  const resetAt = credit ? credit.reset_at : null;
  const isPaid = PAID_PLANS.includes(plan);

  const trialExpired = isTrialExpired(user, credit);

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

  const candidates = lifecycleCandidates({
    days, isPaid, trialExpired,
    viaLoops:       EMAIL_VIA_LOOPS,
    hasName:        !!name,
    resetAt,
    lastSignInDays,
    nowMs:          Date.now(),
    weekKey,
    monthKey:       new Date().toISOString().slice(0, 7), // YYYY-MM
  });

  await runLifecycle(candidates, {
    hasEverGeneratedPlan: () => userHasEverGeneratedPlan(userId),
    fireLoopsEvent: (c) => sendLoopsEventOnce({
      userId, email, eventName: c.template,
      properties: { firstName: name || "" },
      dedupeKey: c.dedupeKey,
    }),
    send: (c) => {
      const tpl = buildLifecycleTemplate(c.template, { name, unsubToken, trialExpired });
      if (!tpl) return false;
      return sendEmail({
        userId, to: email, template: c.template, dedupeKey: c.dedupeKey,
        subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: c.marketing,
      });
    },
  });
}

// [ONE-A-DAY] The cap itself: walk the candidates highest-priority-first and
// stop at the first email that actually goes out. Returns the slugs sent —
// zero or one, never more.
//
// A candidate whose send returns false has either already been delivered (its
// dedupe slot is claimed) or been opted out of, and in both cases the reader's
// inbox is untouched — so the walk continues and the next-best message gets
// its turn. That is what makes this a cap rather than a silencer: a day-20
// free user whose trial_expired went out yesterday still reaches weekly_reset
// today.
//
// Known trade: sendEmail also returns false when Resend itself errors, after
// the dedupe row is already claimed. Such a run falls through to the next
// candidate, so the reader gets the runner-up instead of nothing. That is the
// better of the two failure modes, and the claim-then-send ordering it comes
// from predates this walk.
//
// Dependencies are injected rather than imported so the cap is checkable
// without Supabase, Resend, or a clock — the ordering and the stop-on-first
// rule are the parts that break, and scripts/check-email-program.mjs drives
// this function directly with counting fakes.
export async function runLifecycle(candidates, deps) {
  const sentSlugs = [];
  for (const c of candidates) {
    if (c.requiresNoPlan && await deps.hasEverGeneratedPlan()) continue;

    // [PREMIUM 7] The day-30 milestone rides a different rail — Loops owns
    // the copy and the merge; we only trip the event. It still takes a turn in
    // the same walk so it counts against the cap, and still claims an
    // email_sends slot (audit finding #12) so "Loops dedupes a contact's
    // events" isn't the only thing standing between a paid user and a second
    // congratulations.
    //
    // sendLoopsEventOnce always resolves to an object — `{ deduped: true }`
    // when the slot was already claimed, otherwise the send result. Only a
    // real fire consumes the day's slot; a deduped one lets the walk carry on
    // to weekly_reset, which is what a paid user hits every day after their
    // 30th.
    if (c.loopsEvent) {
      const r = await deps.fireLoopsEvent(c);
      if (r && r.ok && !r.deduped) { sentSlugs.push(c.template); return sentSlugs; }
      continue;
    }

    if (await deps.send(c)) { sentSlugs.push(c.template); return sentSlugs; }
  }
  return sentSlugs;
}

// Template slug → rendered email. Split out so lifecycleCandidates can stay
// pure (it decides WHICH email; this decides what it says) and so the walk
// above has exactly one send call rather than one per trigger.
//
// Notes carried over from the per-trigger bodies this replaced:
//   welcome            — safety net for anyone the inline /api/email/welcome
//                        call missed. Deliberately NOT gated on
//                        EMAIL_VIA_LOOPS: if the Loops automation breaks, the
//                        Resend send still lands. The inline Loops path
//                        pre-claims the same (welcome, "welcome") slot before
//                        firing its event, so there is no double welcome.
//   trial_*            — skipped entirely when EMAIL_VIA_LOOPS is true; Loops
//                        drives the sequence off the contact's signupAt.
//   weekly_reset       — suppressed for expired trials upstream, because its
//                        whole CTA is the generate button api/chat.js answers
//                        with a 402.
//   inactive_7d        — takes trialExpired, which swaps it to the variant
//                        that doesn't promise a plan the API will refuse.
function buildLifecycleTemplate(slug, { name, unsubToken, trialExpired }) {
  switch (slug) {
    case "welcome":            return T.welcome({ name });
    case "phase1_no_plan_24h": return T.phase1NoPlan({ name, unsubscribeToken: unsubToken });
    case "trial_day_7":        return T.trialDay7({ name, unsubscribeToken: unsubToken });
    case "trial_day_11":       return T.trialDay11({ name, unsubscribeToken: unsubToken });
    case "trial_day_13":       return T.trialDay13({ name, unsubscribeToken: unsubToken });
    case "trial_expired":      return T.trialExpired({ name, unsubscribeToken: unsubToken });
    case "weekly_reset":       return T.weeklyReset({ name, unsubscribeToken: unsubToken });
    case "inactive_7d":        return T.inactive7Day({ name, trialExpired, unsubscribeToken: unsubToken });
    case "inactive_30d":       return T.inactive30Day({ name, unsubscribeToken: unsubToken });
    default:                   return null;
  }
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
      const name = await fetchProfileName(userId);
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
  const name = await fetchProfileName(userId);
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
