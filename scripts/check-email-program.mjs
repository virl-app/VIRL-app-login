// scripts/check-email-program.mjs
//
// [EMAIL-PROGRAM] Deterministic, no-network regression net for the email
// PROGRAM — not for any one email, but for the rules that decide which of them
// a person receives, in what order, and how many land in one day.
//
// It exists because the three complaints about VIRL's mail turned out to be
// three defects with the same shape as the grounding gaps check-strategist
// covers: a rule that lived inside one trigger instead of on the shared path,
// with nothing anywhere that would notice when it broke.
//
//   "too frequent"        — the lifecycle pass had no per-run cap at all. Each
//                           trigger sent independently, so one invocation could
//                           deliver six emails to one inbox.
//   "incorrect"           — the trial sequence's four `days >= N` gates all
//                           matched at once for any account that reached day 14
//                           unmailed, so "you're halfway through your trial"
//                           arrived alongside "your trial has ended". Separately,
//                           three templates promised a Monday reset the product
//                           has never had.
//   "not driving action"  — the evening reminder, the only email that names the
//                           creator's actual posts, yielded to EVERY other
//                           template sent that day, including password
//                           confirmations and admin alerts.
//
// Each assertion is written to fail if its fix is reverted; that is the only
// property that makes any of them worth running. Layout mirrors
// check-strategist.mjs: Node ES module, prints OK / FAIL, exits 1 so CI blocks.

import {
  lifecycleCandidates, trialMilestone, runLifecycle,
  userGotOtherEmailToday, REMINDER_YIELDS_TO,
} from "../api/cron/email-triggers.js";
import * as T from "../api/_lib/email-templates.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures += 1;
  console.error("FAIL:", msg);
}

const DAY = 86400000;
const NOW = Date.parse("2026-08-07T14:00:00Z");

// Base context for lifecycleCandidates. Every scenario below overrides only
// the fields it is actually about, so a failure names one variable.
function ctx(over) {
  return Object.assign({
    days:           3,
    isPaid:         false,
    trialExpired:   false,
    viaLoops:       false,
    hasName:        true,
    resetAt:        null,
    lastSignInDays: 0,
    nowMs:          NOW,
    weekKey:        "2026-W32",
    monthKey:       "2026-08",
  }, over || {});
}
const slugs = (c) => lifecycleCandidates(c).map(x => x.template);

// ─── Layer 1: the trial sequence supersedes rather than accumulates ─────────
//
// The exact production shape that produced a four-email burst: a free account
// well past day 14 with none of the four milestones claimed. Before
// supersession this matched trial_day_7, trial_day_11, trial_day_13 AND
// trial_expired in one pass.
{
  assert(trialMilestone(6) === null, "day 6 resolves to a trial email — the sequence starts at day 7");
  assert(trialMilestone(7).template  === "trial_day_7",  "day 7 does not resolve to trial_day_7");
  assert(trialMilestone(10).template === "trial_day_7",  "day 10 skipped ahead — day 8-10 should still hold at the day-7 note");
  assert(trialMilestone(11).template === "trial_day_11", "day 11 does not resolve to trial_day_11");
  assert(trialMilestone(13).template === "trial_day_13", "day 13 does not resolve to trial_day_13");
  assert(trialMilestone(14).template === "trial_expired", "day 14 does not resolve to trial_expired");
  assert(trialMilestone(60).template === "trial_expired", "a long-lapsed account resolves to something other than trial_expired");

  const late = slugs(ctx({ days: 20 })).filter(s => s.startsWith("trial_"));
  assert(late.length === 1,
    `a day-20 free account is eligible for ${late.length} trial emails (${late.join(", ")}) — the whole sequence lands in one delivery`);
  assert(late[0] === "trial_expired",
    `a day-20 free account's trial email is ${late[0]} — an obsolete milestone outranks the one that is actually true`);

  // The happy path must be untouched: supersession is a recovery rule, not a
  // change to the drip anyone already receives correctly.
  assert(slugs(ctx({ days: 11 })).includes("trial_day_11"), "the normal day-11 send was lost to supersession");
  assert(!slugs(ctx({ days: 11 })).includes("trial_expired"), "day 11 is eligible for trial_expired — the sequence runs ahead of itself");
}

// ─── Layer 2: at most one lifecycle email per user per run ─────────────────
//
// Driven through runLifecycle with counting fakes, because the cap IS the
// control flow — asserting on the candidate list alone would pass with the old
// send-everything body still in place.
async function layerCap() {
  // The burst account: free, past the trial, idle for a week and a half, with
  // a rolled-over credit window. Eligible for a pile of things at once.
  const burst = ctx({
    days: 20, trialExpired: true, lastSignInDays: 10,
    resetAt: new Date(NOW - 2 * DAY).toISOString(),
  });
  const cands = lifecycleCandidates(burst);
  assert(cands.length >= 2,
    "the burst fixture is eligible for fewer than two emails — it no longer exercises the cap");

  const fakes = (opts) => {
    const attempted = [];
    return {
      attempted,
      hasEverGeneratedPlan: async () => (opts && opts.hasPlan) || false,
      fireLoopsEvent: async (c) => { attempted.push(c.template); return { ok: true }; },
      send: async (c) => { attempted.push(c.template); return !(opts && opts.claimed || []).includes(c.template); },
    };
  };

  const f1 = fakes();
  const sent1 = await runLifecycle(cands, f1);
  assert(sent1.length === 1,
    `one run delivered ${sent1.length} emails (${sent1.join(", ")}) to one inbox — the per-run cap is gone`);
  assert(sent1[0] === "trial_expired",
    `the burst account's single email was ${sent1[0]}, not trial_expired — priority order is wrong`);

  // Already-sent must fall THROUGH, not stop the walk. Otherwise the cap turns
  // into a silencer: the top candidate's claimed dedupe slot would mute the
  // account permanently.
  const f2 = fakes({ claimed: ["trial_expired"] });
  const sent2 = await runLifecycle(cands, f2);
  assert(sent2.length === 1 && sent2[0] !== "trial_expired",
    "a claimed top-priority slot ends the run instead of yielding to the next candidate — every later email is permanently muted");
  assert(f2.attempted.length > f1.attempted.length,
    "the walk stopped at the same point whether or not the first candidate actually sent");

  // Nothing eligible must send nothing — the cap is a ceiling, not a quota.
  const sent3 = await runLifecycle([], fakes());
  assert(sent3.length === 0, "an empty candidate list still sent something");

  // requiresNoPlan defers its round trip and skips rather than sends.
  let planLookups = 0;
  const phase1 = lifecycleCandidates(ctx({ days: 3 }));
  assert(phase1.some(c => c.requiresNoPlan),
    "the day-3 fixture has no requiresNoPlan candidate — phase1_no_plan_24h lost its gate");
  const sent4 = await runLifecycle(phase1.filter(c => c.requiresNoPlan), {
    hasEverGeneratedPlan: async () => { planLookups++; return true; },
    fireLoopsEvent: async () => ({ ok: true }),
    send: async () => true,
  });
  assert(planLookups === 1, `the plan lookup ran ${planLookups} times for one candidate`);
  assert(sent4.length === 0,
    "a user who has already generated a plan still received the you-have-no-plan-yet email");

  // A deduped Loops milestone must not consume the day's slot — otherwise a
  // paid user goes permanently dark from day 30 onward, since the milestone
  // dedupes forever and would swallow every run.
  const paid = lifecycleCandidates(ctx({
    days: 40, isPaid: true, lastSignInDays: 1,
    resetAt: new Date(NOW - DAY).toISOString(),
  }));
  assert(paid.some(c => c.loopsEvent), "the paid day-40 fixture lost its milestone candidate");
  const dedupedSent = await runLifecycle(paid, {
    hasEverGeneratedPlan: async () => true,
    fireLoopsEvent: async () => ({ ok: true, deduped: true }),
    send: async () => true,
  });
  assert(dedupedSent.length === 1 && dedupedSent[0] === "weekly_reset",
    `an already-fired day-30 milestone consumed the run (sent: ${dedupedSent.join(", ") || "nothing"}) — every paid user past day 30 stops hearing from us`);
}

// ─── Layer 3: eligibility windows still partition ──────────────────────────
{
  // The two win-back tiers must not both match. This was fixed once already
  // (upper bound `<= 30` → `< 30`); the cap would now hide a regression by
  // sending only one, so it is asserted on the candidate list directly.
  const at30 = slugs(ctx({ days: 40, lastSignInDays: 30, trialExpired: true }));
  assert(!(at30.includes("inactive_7d") && at30.includes("inactive_30d")),
    "at exactly 30 days idle a user is eligible for BOTH win-back emails");

  // weekly_reset stays suppressed for expired trials: its whole CTA is the
  // generate button api/chat.js answers with a 402.
  const expired = slugs(ctx({
    days: 30, trialExpired: true, resetAt: new Date(NOW - DAY).toISOString(),
  }));
  assert(!expired.includes("weekly_reset"),
    "an expired free trial is eligible for weekly_reset, whose only CTA the API refuses with a 402");

  // …and is NOT suppressed for anyone still inside the trial.
  const live = slugs(ctx({ days: 8, resetAt: new Date(NOW - DAY).toISOString() }));
  assert(live.includes("weekly_reset"), "an active account lost its weekly reset nudge");

  // A future reset_at must not fire early — the bug that sent this a day
  // early, every week, to anyone off the Monday cadence.
  const early = slugs(ctx({ days: 8, resetAt: new Date(NOW + DAY).toISOString() }));
  assert(!early.includes("weekly_reset"),
    "the weekly reset fires before the user's credit window has actually rolled over");

  // EMAIL_VIA_LOOPS drops the whole Resend trial sequence and nothing else.
  const viaLoops = slugs(ctx({ days: 13, viaLoops: true }));
  assert(!viaLoops.some(s => s.startsWith("trial_")),
    "EMAIL_VIA_LOOPS is on and the Resend trial sequence still fires — subscribers get both");
  assert(slugs(ctx({ days: 13, viaLoops: false })).some(s => s.startsWith("trial_")),
    "the Resend trial sequence is gone even with EMAIL_VIA_LOOPS off");

  // Paid users never get trial mail.
  assert(!slugs(ctx({ days: 13, isPaid: true })).some(s => s.startsWith("trial_")),
    "a paying customer is eligible for trial-conversion mail");
}

// ─── Layer 4: the reminder yields to conversion mail, not to everything ────
//
// Driven against a stubbed fetch so a revert to the old two-name denylist
// fails here. The templates below are the ones that were silencing tomorrow's
// posting reminder for no defensible reason.
async function layerReminderYield() {
  const realFetch = globalThis.fetch;
  const withRows = async (templates, fn) => {
    globalThis.fetch = async () => ({
      ok: true, json: async () => templates.map(t => ({ template: t })),
    });
    try { return await fn(); } finally { globalThis.fetch = realFetch; }
  };

  const mustNotMute = [
    ["password_changed",     "a password confirmation"],
    ["referral_rewarded",    "a referral payout"],
    ["renewal_upcoming",     "a renewal receipt"],
    ["trend_pipeline_stale", "an admin-only pipeline alert"],
    ["first_plan_generated", "the congratulations for the very plan being reminded about"],
    ["inactive_7d",          "a generic win-back check-in"],
    ["trial_day_7",          "a mid-trial check-in with no deadline in it"],
  ];
  for (const [tpl, label] of mustNotMute) {
    const muted = await withRows([tpl], () => userGotOtherEmailToday("u1"));
    assert(muted === false,
      `${label} (${tpl}) silences tonight's posting reminder — the most specific email in the program loses to the least`);
  }

  const mustMute = [
    ["trial_expired",      "the trial-has-ended notice"],
    ["trial_day_13",       "the last-day warning"],
    ["weekly_reset",       "the same generate-your-week ask, same day"],
    ["phase1_no_plan_24h", "the same generate-your-week ask, same day"],
    ["welcome",            "a day-zero welcome"],
  ];
  for (const [tpl, label] of mustMute) {
    const muted = await withRows([tpl], () => userGotOtherEmailToday("u1"));
    assert(muted === true,
      `${label} (${tpl}) does not defer the reminder — the reader gets two asks in one evening`);
  }

  // The reminder pair must never mute itself or its sibling.
  const selfMute = await withRows(["posting_reminder", "sunday_reset"], () => userGotOtherEmailToday("u1"));
  assert(selfMute === false, "the reminder emails count themselves as competing mail");

  // Nothing sent today → nothing to yield to.
  assert(await withRows([], () => userGotOtherEmailToday("u1")) === false,
    "an empty send history reads as though the user was already emailed");

  // Fails OPEN on a read error: a Supabase blip must not cancel the reminder.
  globalThis.fetch = async () => ({ ok: false, json: async () => [] });
  const onError = await userGotOtherEmailToday("u1");
  globalThis.fetch = realFetch;
  assert(onError === false, "a failed email_sends read suppresses the reminder instead of failing open");

  // The allowlist must stay an allowlist. A denylist revert shows up as the
  // reminder slugs being the only names in it.
  assert(!REMINDER_YIELDS_TO.has("posting_reminder") && !REMINDER_YIELDS_TO.has("sunday_reset"),
    "REMINDER_YIELDS_TO names the reminder templates themselves — that is the inverted denylist");
}

// ─── Layer 5: no template claims a reset day the product does not have ─────
//
// Credits and plan expiry key off credits.reset_at, a per-user rolling window
// re-anchored to now()+7d on each generation (api/chat.js). It lands on a
// Monday about one week in seven. Three templates said Monday anyway.
{
  const tok = "tok";
  const mondayFree = [
    ["firstPlanGenerated", T.firstPlanGenerated({ name: "Dana" })],
    ["inactive7Day",       T.inactive7Day({ name: "Dana", unsubscribeToken: tok })],
    ["subscriptionWelcome", T.subscriptionWelcome({ name: "Dana", plan: "founding" })],
    ["weeklyReset",        T.weeklyReset({ name: "Dana", unsubscribeToken: tok })],
    ["trialDay7",          T.trialDay7({ name: "Dana", unsubscribeToken: tok })],
    ["phase1NoPlan",       T.phase1NoPlan({ name: "Dana", unsubscribeToken: tok })],
  ];
  for (const [nameOf, tpl] of mondayFree) {
    for (const part of ["subject", "html", "text"]) {
      assert(!/\bMonday\b/i.test(tpl[part]),
        `${nameOf}.${part} promises a Monday reset — credits roll on each user's own 7-day window, so this is wrong for roughly six accounts in seven`);
    }
  }

  // The one email that legitimately names weekdays is the Sunday reset, which
  // really is sent on Sunday about really-tomorrow's Monday cards. Asserting
  // it KEEPS its weekday keeps the rule above from being satisfied by a blanket
  // find-and-replace.
  const sun = T.sundayReset({
    name: "Dana", unloggedCount: 2, hasPlan: true,
    cards: [{ title: "Open house recap", platform: "Instagram", postTime: "7:00 PM" }],
    unsubscribeToken: tok,
  });
  assert(/\bMonday\b/.test(sun.html),
    "the Sunday reset no longer names Monday — it is sent Sunday evening about Monday's cards and should say so");
}

// ─── Layer 6: the win-back email does not pitch an action the API refuses ──
//
// inactive_7d's floor is days >= 14, so for a FREE account it can only ever
// arrive after the trial has expired — and api/chat.js answers its CTA with a
// 402 for exactly that reader.
{
  const tok = "tok";
  const open    = T.inactive7Day({ name: "Dana", unsubscribeToken: tok, trialExpired: false });
  const expired = T.inactive7Day({ name: "Dana", unsubscribeToken: tok, trialExpired: true });

  assert(open.subject !== expired.subject,
    "the expired-trial win-back sends the same subject as the one for accounts that can still generate");
  assert(!/60 seconds/i.test(expired.html) && !/60 seconds/i.test(expired.text),
    "the expired-trial win-back still promises to build a fresh week — the exact request api/chat.js answers with a 402");
  assert(/upgrade|plans/i.test(expired.html),
    "the expired-trial win-back names no way forward — it tells a lapsed account nothing it can act on");
  assert(/tab=account/.test(expired.html),
    "the expired-trial win-back's CTA still points somewhere other than the upgrade surface");
  assert(/60 seconds/i.test(open.html),
    "the ordinary win-back lost its generate offer — that one is still a live action");

  // The trigger must actually pass the flag through; a variant nothing selects
  // is the same as no variant.
  const src = readFileSync(new URL("../api/cron/email-triggers.js", import.meta.url), "utf8");
  assert(/inactive7Day\([^)]*trialExpired/.test(src),
    "the trigger renders inactive7Day without trialExpired — the expired variant exists but nothing ever selects it");
}

// ─── Layer 7: no exported template is an orphan ────────────────────────────
//
// The rule that would have caught sundayLogNudge, which sat exported and
// unreferenced after its content was folded into sundayReset. An exported
// builder with no caller reads like a feature that ships; establishing that it
// does not cost a full audit of the file.
{
  const tplPath = new URL("../api/_lib/email-templates.js", import.meta.url);
  const tplSrc  = readFileSync(tplPath, "utf8");
  const exported = [...tplSrc.matchAll(/^export function (\w+)/gm)].map(m => m[1]);
  assert(exported.length > 15, `only ${exported.length} template exports found — the scan is not seeing the file`);

  // Every .js under api/ except the template module itself.
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith(".js") && !p.endsWith("email-templates.js")) out.push(p);
    }
    return out;
  };
  const apiDir = new URL("../api", import.meta.url).pathname;
  const callerSrc = walk(apiDir).map(p => readFileSync(p, "utf8")).join("\n");

  for (const fn of exported) {
    assert(new RegExp("\\b" + fn + "\\b").test(callerSrc),
      `email-templates.js exports ${fn}() and nothing under api/ calls it — either wire it up or delete it`);
  }
}

// ─── Run the async layers, then report ─────────────────────────────────────
await layerCap();
await layerReminderYield();

if (failures > 0) {
  console.error(`\nEmail program check FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log("OK: one lifecycle email per run, trial sequence supersedes, reminder yields only to conversion mail, no orphan templates.");
