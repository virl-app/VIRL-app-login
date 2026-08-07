// scripts/check-strategist.mjs
//
// [STRATEGIST-EVAL] Deterministic, no-network regression net for the OTHER
// half of the promise. scripts/check-voice.mjs guards "sounds like the
// creator"; this guards "grounded in the creator's industry, the platform's
// real mechanics, and what is actually happening now."
//
// It exists because every defect it covers had the same shape: a signal wired
// to one builder instead of the shared path, and nothing anywhere that would
// notice. The trend-grounding rule reached one surface of nine. The niche
// playbook had one call site. Three builders quoted hashtag counts from string
// literals while the live playbook sat in scope unread. Nothing read
// `updated_at`, so a two-year-old row introduced itself to the model in the
// same words as one approved yesterday.
//
// Each assertion below is written to fail if its fix is reverted — that is the
// only property that makes any of them worth running. The layout mirrors
// check-voice.mjs: Node ES module, prints OK / FAIL, exits 1 so CI blocks.

import { dispatch } from "../api/_lib/prompts.js";
import { playbookAge, PLAYBOOK_STALE_DAYS } from "../api/_lib/playbook.js";
import { formatNichePlaybookForPrompt } from "../api/_lib/niche-playbook.js";
import { readFileSync } from "node:fs";

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures += 1;
  console.error("FAIL:", msg);
}

const PROFILE = {
  name: "Dana",
  audience: "first-time sellers in the Nashville suburbs",
  myPlatforms: ["Instagram", "TikTok"],
};

// A real-estate profile with every optional business field BLANK — the exact
// creator the niche gap was about. Picking "Real Estate" and filling in
// nothing left buildProfileCtx with nothing to say, so this profile is the one
// that proves the industry grounding comes from the niche layer rather than
// from fields the creator may never have typed.
const BARE_REAL_ESTATE = { name: "Dana", myPlatforms: ["Instagram"] };

const DAY = 86400000;
function isoDaysAgo(d) { return new Date(Date.now() - d * DAY).toISOString(); }

// Playbook fixture with a controllable age. Values are deliberately NOT the
// numbers the removed static tables used ("3-5" hashtags, "~210 characters"),
// so an assertion can tell which source a prompt actually quoted.
function playbookFixture(daysOld) {
  const updated_at = isoDaysAgo(daysOld == null ? 5 : daysOld);
  return {
    Instagram: {
      platform: "Instagram", updated_at,
      cadence: "4-6x/week", peak_times: "11am-1pm and 7-9pm local",
      duration: "15-60s", hook_window: "first 2 seconds",
      hashtag_count: "6-9", hashtag_mix: "2 broad, 4 niche",
      caption_limit: 2200,
      top_signals: ["saves", "shares"], format_priority: ["Reels", "carousels"],
    },
    TikTok: {
      platform: "TikTok", updated_at,
      cadence: "daily", peak_times: "6-9pm local",
      hook_window: "first 1.5 seconds",
      hashtag_count: "3-5", caption_limit: 4000,
      top_signals: ["completion rate"], format_priority: ["short video"],
    },
    LinkedIn: {
      platform: "LinkedIn", updated_at,
      hook_window: "first 140 characters before the fold",
      caption_limit: 3000, hashtag_count: "2-4", hashtag_mix: "topic tags",
      peak_times: "Tue-Thu 8-10am",
      top_signals: ["dwell time", "comments"], format_priority: ["text posts", "document carousels"],
    },
  };
}

const TREND_BLOCK = "THIS WEEK'S TRENDS (Instagram)\n- FIXTURE_TREND_ITEM — a POV walkthrough format, rising.";

// Every surface in BUILDERS that emits prose a human reads. log_metrics and
// voice_sample_extract are excluded: they read pixels and write numbers or a
// verbatim transcription, so none of the grounding below applies to them.
const PROSE_SURFACES = [
  { label: "plan",             gt: "plan",             params: { platforms: ["Instagram"], formats: ["video"], niche: "Real Estate", goal: "Sell my services", followers: "1K-5K" } },
  { label: "plan_partial",     gt: "plan_partial",     params: { platforms: ["Instagram"], formats: ["video"], niche: "Real Estate", goal: "Sell my services", followers: "1K-5K", replaceSlots: [{ day: "Day 1 - Mon", platform: "Instagram", format: "video" }], strategy: {} } },
  { label: "script",           gt: "script",           params: { niche: "Real Estate", card: { title: "Open house tour", platform: "Instagram", format: "video" } } },
  { label: "long_post",        gt: "long_post",        params: { niche: "Real Estate", topic: "pricing a home", length: "medium" } },
  { label: "blog_post",        gt: "blog_post",        params: { niche: "Real Estate", topic: "pricing a home", length: "medium" } },
  { label: "caption",          gt: "caption",          params: { niche: "Real Estate", platform: "Instagram", topic: "open house" } },
  { label: "caption_remix",    gt: "caption_remix",    params: { niche: "Real Estate", text: "come see the house on saturday" } },
  { label: "scan_image",       gt: "scan_image",       params: { niche: "Real Estate" } },
  { label: "scan_video_frame", gt: "scan_video_frame", params: { niche: "Real Estate" } },
];

function build(gt, params, opts) {
  const o = opts || {};
  return dispatch(
    gt, params, o.profile || PROFILE, null,
    o.playbook || {}, o.trends === undefined ? {} : o.trends,
    [], null, null, null
  );
}
function systemOf(built) {
  const sp = built.systemPrompt;
  if (typeof sp === "string") return sp;
  return (sp.shared || "") + "\n" + (sp.perUser || "");
}
function sharedOf(built) {
  const sp = built.systemPrompt;
  return (typeof sp === "string") ? sp : (sp.shared || "");
}
function wholeOf(built) { return systemOf(built) + "\n" + (built.userPrompt || ""); }

// ── Layer 1: trend grounding is structural ──────────────────────────────────
//
// TREND_SOURCE_RULE lived in buildPlan's USER prompt, so it reached exactly
// one surface: plan_partial reuses only the system prompt, and the other seven
// never saw it at all. The rule now rides the SHARED system tier on every
// surface, which is the assertion below — checking the system prompt
// specifically, because passing on the whole prompt is what a user-prompt-only
// rule would also do.
for (const s of PROSE_SURFACES) {
  const built = build(s.gt, s.params, { playbook: playbookFixture() });
  assert(/TREND GROUNDING — STRUCTURAL/.test(sharedOf(built)),
    `${s.label}: the trend-grounding rule is not in the SHARED system tier — it reaches this surface only if some user prompt happens to carry it`);
}

// The rule has to hold on its own when no block follows it. Its predecessor
// said "the TRENDS block below is your ONLY source", which is an instruction
// with a dangling referent on any surface that renders no block — and a
// dangling referent reads as an omission the model should fill in.
{
  const built = build("caption", { niche: "Real Estate", platform: "Instagram", topic: "x" }, { playbook: playbookFixture() });
  assert(/If it does NOT appear|no TRENDS block/i.test(sharedOf(built)),
    "the trend rule does not say what to do when no TRENDS block is present — it dangles on every surface that renders none");
}

// Silence is the failure mode. With no trends supplied, every prose surface
// must NAME the absence rather than simply omitting the section.
for (const s of PROSE_SURFACES) {
  const built = build(s.gt, s.params, { playbook: playbookFixture(), trends: "" });
  assert(/TRENDS: NONE/.test(built.userPrompt || ""),
    `${s.label}: no trends supplied and the prompt says nothing about it — silence is what let the model answer from training data`);
}

// The other half of the same invariant: a builder handed trends must RENDER
// them. Several builders took the argument as `_trends` and dropped it while
// the prompt went on discussing what was trending — signal threaded, signal
// discarded, instruction surviving.
for (const s of PROSE_SURFACES) {
  const built = build(s.gt, s.params, { playbook: playbookFixture(), trends: TREND_BLOCK });
  assert((built.userPrompt || "").includes("FIXTURE_TREND_ITEM"),
    `${s.label}: trends were passed to the builder and never reached the prompt`);
}

// Scan solicits `audio_idea`. It used to ask for "a trending-audio ...
// direction" on a surface with no grounding rule — the prompt requesting the
// one claim it had no basis for.
{
  const scan = build("scan_image", { niche: "Real Estate" }, { playbook: playbookFixture(), trends: "" });
  const user = scan.userPrompt || "";
  assert(/audio_idea/.test(user), "scan no longer emits audio_idea — fixture is stale");
  assert(!/"audio_idea":"OPTIONAL Reel\/Video only — a trending-audio or sound direction/.test(user),
    "scan's audio_idea asks for a trending sound with no grounding qualifier");
  assert(/appears in the TRENDS block/.test(user),
    "scan's audio_idea does not tie a named sound to the TRENDS block");
}

// The collection link. chat.js is a Vercel handler with module-level config, so
// this reads its source the way check-voice.mjs reads the trend verifier's —
// coarse and source-level, but it catches a builder that renders trends for a
// surface nothing ever collects them for.
{
  const chatSrc = readFileSync(new URL("../api/chat.js", import.meta.url), "utf8");
  const freshBlock = (chatSrc.match(/const FRESH_TRENDS_TYPE = \{[\s\S]*?\};/) || [""])[0];
  assert(freshBlock, "FRESH_TRENDS_TYPE is gone from chat.js — nothing decides which surfaces collect trends");
  for (const gt of ["script", "long_post", "blog_post"]) {
    assert(new RegExp("\\b" + gt + "\\s*:").test(freshBlock),
      `${gt} is missing from FRESH_TRENDS_TYPE — its builder renders a trend section that can never be populated`);
  }
  // caption_remix stays out on purpose: the request carries only the text to
  // rewrite, so there is no platform to query the pipeline with. Its builder
  // still renders the named empty state, which is why the exclusion is safe.
  assert(!/\bcaption_remix\s*:/.test(freshBlock),
    "caption_remix was added to FRESH_TRENDS_TYPE — it has no platform to query, so this collects nothing while implying it does");
  const pickBlock = (chatSrc.match(/function pickInlinePlatforms[\s\S]*?\n\}/) || [""])[0];
  for (const gt of ["script", "long_post", "blog_post"]) {
    assert(pickBlock.includes("'" + gt + "'") || pickBlock.includes('"' + gt + '"'),
      `pickInlinePlatforms has no branch for ${gt} — it is in FRESH_TRENDS_TYPE but resolves to no platform, so the query never runs`);
  }
}

// ── Layer 2: the niche/industry layer leaves the plan ───────────────────────
//
// formatNichePlaybookForPrompt had one call site and getFormatGuidance one,
// both inside buildPlan. Seven surfaces carried no model of how content
// converts in the creator's vertical — and what survived (offerings, service
// area, ideal-client problem) is optional on every one of those fields.
for (const s of PROSE_SURFACES) {
  const built = build(s.gt, s.params, { playbook: playbookFixture() });
  assert(/NICHE SUCCESS (MODEL|PLAYBOOK)/.test(wholeOf(built)),
    `${s.label}: carries no niche success model — it cannot know how content converts in this creator's vertical`);
}

// The content of the model has to be the creator's actual vertical, not a
// generic bucket, and it has to arrive for a profile with every optional
// business field blank.
for (const s of PROSE_SURFACES) {
  const built = build(s.gt, s.params, { profile: BARE_REAL_ESTATE, playbook: playbookFixture() });
  const whole = wholeOf(built);
  assert(/People hire the agent they feel they already know/.test(whole),
    `${s.label}: a Real Estate creator with no optional profile fields gets no real-estate grounding`);
  assert(/DMs and profile visits|attract|Attract/.test(whole),
    `${s.label}: niche block reaches the prompt without the funnel intent or KPI signal`);
}

// The per-niche model belongs in the SHARED (cacheable) tier — it depends on
// nothing but the niche bucket. Plan and plan_partial are excluded: they carry
// the fuller per-request renderer (goal tactics, follower tier) in the user
// prompt, which is where per-request data has to live.
for (const s of PROSE_SURFACES) {
  if (s.gt === "plan" || s.gt === "plan_partial") continue;
  const built = build(s.gt, s.params, { playbook: playbookFixture() });
  assert(/NICHE SUCCESS MODEL/.test(sharedOf(built)),
    `${s.label}: the per-niche model is not in the shared cache tier — it is per-niche constant and would be paid for on every request`);
}

// plan_partial loses everything in buildPlan's user prompt, which is where the
// industry format mix and this week's business context live. Regenerate the
// card built around the creator's open house and, before this, the replacement
// did not know the open house existed.
{
  const built = build("plan_partial", Object.assign({}, PROSE_SURFACES[1].params, {
    weekContext:    "FIXTURE_OPEN_HOUSE on Saturday at 14 Maple.",
    listingContext: "FIXTURE_LISTING_FACTS: 3 bed, 2 bath, listed at 415000.",
  }), { playbook: playbookFixture(), trends: TREND_BLOCK });
  const user = built.userPrompt || "";
  assert(user.includes("FIXTURE_OPEN_HOUSE"),
    "plan_partial: this week's business context never reaches the replacement card");
  assert(user.includes("FIXTURE_LISTING_FACTS"),
    "plan_partial: the featured listing never reaches the replacement card");
  assert(/FORMAT MIX FOR THIS CREATOR'S INDUSTRY/.test(user),
    "plan_partial: no industry format mix — the replacement is formatted from generic priors");
  assert(/NICHE SUCCESS PLAYBOOK/.test(user),
    "plan_partial: no niche playbook — the replacement does not know what winning looks like in this vertical");
  assert(/PLATFORM PLAYBOOK FOR Instagram/.test(user),
    "plan_partial: no platform playbook, while the shared system prompt still tells it to follow the playbook's hashtag_count");
}

// Missing data is not negative data. An empty followers value used to fall
// through to the smallest tier, so any surface without one would have been
// told "Under 1K followers" as a fact about the creator's account.
{
  const withTier = formatNichePlaybookForPrompt("Real Estate", "", "", "20K-100K");
  const noTier   = formatNichePlaybookForPrompt("Real Estate", "", "", "");
  assert(/FOLLOWER-TIER BASELINE/.test(withTier),
    "a stated follower tier no longer renders its baseline");
  assert(!/FOLLOWER-TIER BASELINE/.test(noTier),
    "an unstated follower count still renders a tier baseline — absence is being read as 'under 1K'");
}

// ── Layer 3: live playbook values beat static in-prompt tables ──────────────
//
// hashtagSlots had exactly one call site (buildCaption). Everywhere else the
// counts were string literals, so the surface quoted a number the monthly
// research could not reach. The fixture's counts are chosen not to match the
// literals they replaced, so these assertions distinguish the two sources.
{
  const caption = build("caption", { niche: "Real Estate", platform: "Instagram", topic: "open house" }, { playbook: playbookFixture() });
  const user = caption.userPrompt || "";
  assert(user.includes('"tag9"'), "caption: hashtag slots do not follow the playbook's hashtag_count upper bound");
  assert(!user.includes('"tag10"'), "caption: hashtag slots exceed the playbook's hashtag_count");
}
{
  const lp = build("long_post", { niche: "Real Estate", topic: "pricing", length: "medium" }, { playbook: playbookFixture() });
  const user = lp.userPrompt || "";
  assert(!/3-5 LinkedIn hashtags/.test(user),
    "long_post: still states its own hashtag count instead of reading the playbook");
  assert(user.includes('"tag4"') && !user.includes('"tag5"'),
    "long_post: hashtag slots do not match the playbook's LinkedIn hashtag_count (2-4)");
  assert(user.includes("first 140 characters before the fold"),
    "long_post: the see-more fold is a static constant, not the playbook's LinkedIn hook_window");
  assert(!/~210 characters/.test(user),
    "long_post: the hardcoded ~210-character fold is back and shadows the playbook value");
  assert(/Body character limit: 3000/.test(user),
    "long_post: the playbook's LinkedIn caption_limit never reaches the prompt");
}
{
  const scan = build("scan_image", { niche: "Real Estate" }, { playbook: playbookFixture() });
  const user = scan.userPrompt || "";
  assert(/caption limit: 2200 chars/.test(user),
    "scan: asserts a caption_limit rule while the playbook's caption_limit is never passed — the original defect");
  assert(/hashtags: 6-9/.test(user),
    "scan: the playbook's hashtag_count never reaches the prompt, so only the static per-post-type table remains");
  assert(/peak times: 11am-1pm and 7-9pm local/.test(user),
    "scan: the playbook's peak_times never reaches the prompt");
  assert(/PRECEDENCE/.test(user),
    "scan: nothing says the live playbook numbers outrank the static post-type ranges");
  assert(/"post_when"/.test(user),
    "scan: renders a platform verdict with no field for when to post it");
}
// The scan verdict's timing has to survive to the screen, not just the prompt.
{
  const indexSrc = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert(/r\.post_when/.test(indexSrc),
    "index.html never renders post_when — the server emits the posting window and the creator never sees it");
}
// blog_post: the recorded decision is that a blog is not a social platform and
// takes no playbook data. Asserted so the decision stays a decision rather than
// decaying into someone wiring LinkedIn's numbers into a CMS.
{
  const blog = build("blog_post", { niche: "Real Estate", topic: "pricing", length: "medium" }, { playbook: playbookFixture() });
  const whole = wholeOf(blog);
  assert(!/LINKEDIN PLAYBOOK|PLATFORM PLAYBOOK|PLATFORM PLAYBOOK FOR/.test(whole),
    "blog_post now carries platform playbook data — a blog has no feed mechanics, and borrowing another platform's numbers invents a constraint");
  assert(/NOT social platform hashtags/.test(whole),
    "blog_post's tag field no longer says these are CMS tags, not platform hashtags");
}

// ── Layer 4: playbook staleness is bounded and stated ───────────────────────
//
// Nothing read `updated_at`. A row untouched for two years introduced itself
// to the model with the same authority claim as one approved yesterday.
{
  const fresh   = playbookAge(playbookFixture(5), ["Instagram"]);
  const stale   = playbookAge(playbookFixture(PLAYBOOK_STALE_DAYS + 1), ["Instagram"]);
  const unknown = playbookAge({ Instagram: { platform: "Instagram" } }, ["Instagram"]);
  assert(fresh.known && fresh.days === 5 && !fresh.stale, "playbookAge misreads a 5-day-old row");
  assert(stale.known && stale.stale, `playbookAge does not flag a row older than ${PLAYBOOK_STALE_DAYS} days`);
  assert(!unknown.known && !unknown.stale,
    "a row with no updated_at reads as stale — missing data is being treated as negative data");
  // Oldest entry wins: a plan spanning platforms is only as current as its
  // least-recently-verified row, and the creator reads them as equally live.
  const mixed = playbookAge({
    Instagram: { updated_at: isoDaysAgo(2) },
    TikTok:    { updated_at: isoDaysAgo(400) },
  }, ["Instagram", "TikTok"]);
  assert(mixed.days === 400, "playbookAge reports the newest row, not the oldest — a stale platform hides behind a fresh one");
}
{
  const freshPlan = build("plan", PROSE_SURFACES[0].params, { playbook: playbookFixture(5) });
  const stalePlan = build("plan", PROSE_SURFACES[0].params, { playbook: playbookFixture(400) });
  assert(/verified 5 days ago/.test(freshPlan.userPrompt || ""),
    "plan: the playbook block does not state its age");
  assert(/treat as authoritative/.test(freshPlan.userPrompt || ""),
    "plan: a fresh playbook lost its authority framing");
  assert(/STALE — last verified 400 days ago/.test(stalePlan.userPrompt || ""),
    "plan: a 400-day-old playbook does not announce its age");
  assert(!/treat as authoritative/.test(stalePlan.userPrompt || ""),
    "plan: a 400-day-old playbook is still framed as authoritative — the framing is not a function of age");
}
{
  const staleLong = build("long_post", { niche: "Real Estate", topic: "x", length: "medium" }, { playbook: playbookFixture(400) });
  assert(!/current best practice from monthly research/.test(staleLong.userPrompt || ""),
    "long_post: a stale LinkedIn playbook still calls itself current best practice");
  assert(/STALE — last verified/.test(staleLong.userPrompt || ""),
    "long_post: a stale playbook does not surface its age");
  const staleCaption = build("caption", { niche: "Real Estate", platform: "Instagram", topic: "x" }, { playbook: playbookFixture(400) });
  assert(/last verified 400 days ago/.test(staleCaption.userPrompt || ""),
    "caption: a stale playbook passes its numbers along with no staleness note");
  const freshCaption = build("caption", { niche: "Real Estate", platform: "Instagram", topic: "x" }, { playbook: playbookFixture(5) });
  assert(!/last verified/.test(freshCaption.userPrompt || ""),
    "caption: a fresh playbook pays for a staleness note it does not need");
}
// An empty playbook must not claim authority OR raise a false alarm.
{
  const noPlaybook = build("plan", PROSE_SURFACES[0].params, { playbook: {} });
  assert(!/STALE — last verified/.test(noPlaybook.userPrompt || ""),
    "an absent playbook is reported as stale rather than absent");
}

// Refresh failure must reach a human. The gate was `drafted > 0`, so a total
// research outage and a quiet month produced the same observable: no email.
{
  const cronSrc = readFileSync(new URL("../api/cron/playbook-refresh.js", import.meta.url), "utf8");
  assert(/errored > 0/.test(cronSrc),
    "cron/playbook-refresh notifies only on drafted > 0 — a broken research run is silent");
  assert(/stalePending/.test(cronSrc),
    "cron/playbook-refresh does not check for drafts left unapproved — approval is the one link with a human in it");
  assert(/errors\.push|recordError/.test(cronSrc),
    "cron/playbook-refresh counts failures without recording why, so the alert cannot say what broke");
}

// ── Layer 5: a plan card can be acted on when the creator reads it ─────────
//
// Day 1 is today, the prompt said to put postTime inside the platform's peak
// window, and nothing told the model what time it was — buildClientNow sent
// the weekday and stopped there. So a plan generated at 10am scheduled a 7:00
// AM card for that same morning. A link-1 break: the fact never left the
// browser, so no prompt rule could have saved it.
const CLIENT_NOW = { iso: "2026-08-07", weekday: 5, year: 2026, hour: 15, minute: 20, localTime: "3:20 PM", tz: "America/Chicago" };

{
  const planParams    = Object.assign({}, PROSE_SURFACES[0].params, { clientNow: CLIENT_NOW });
  const partialParams = Object.assign({}, PROSE_SURFACES[1].params, { clientNow: CLIENT_NOW });
  const plan    = build("plan",         planParams,    { playbook: playbookFixture() });
  const partial = build("plan_partial", partialParams, { playbook: playbookFixture() });

  // The rule is constant text, so it belongs in the cached system tier — and
  // that placement is also the only thing that gets it to plan_partial, which
  // inherits the system prompt and writes its own user prompt.
  for (const [label, built] of [["plan", plan], ["plan_partial", partial]]) {
    assert(/SCHEDULING REALISM/.test(sharedOf(built)),
      `${label}: no scheduling-realism rule in the shared system tier — nothing stops a Day 1 card landing in the past`);
    assert(/at least 60 minutes/.test(sharedOf(built)),
      `${label}: the rule states no headroom, so "five minutes from now" counts as schedulable`);
  }

  // The clock is per-request, so it has to reach BOTH user prompts. The rule
  // is written to activate only when a time is actually stated; without this
  // line it is inert.
  for (const [label, built] of [["plan", plan], ["plan_partial", partial]]) {
    const user = built.userPrompt || "";
    assert(user.includes("3:20 PM"),
      `${label}: the creator's current local time never reaches the prompt — the scheduling rule has nothing to compare against`);
    assert(user.includes("America/Chicago"),
      `${label}: the creator's timezone is dropped, so "3:20 PM" is ambiguous`);
  }

  // The pre-existing peak-window instruction is an unqualified order sitting
  // in the same prompt. Left as-is it outranks the rule at the exact moment
  // the model picks a time for Day 1.
  assert(/peak window — except on Day 1/.test(plan.userPrompt || ""),
    "plan: the peak-window instruction is unqualified, so it still tells the model to use a window that has already closed");

  // An older client that sends no time must degrade to the previous behavior,
  // not to a confidently wrong one. Asserting no time is claimed when none was
  // given — inventing "RIGHT NOW it is 12:00 AM" would be worse than silence.
  const noClock = build("plan", PROSE_SURFACES[0].params, { playbook: playbookFixture() });
  assert(!/RIGHT NOW it is/.test(noClock.userPrompt || ""),
    "plan: a request with no clientNow still asserts a current time — that is invented data");
}

// The browser end of the same chain, plus the deterministic backstop.
{
  const indexSrc = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const clientNowFn = (indexSrc.match(/function buildClientNow\(\)[\s\S]*?\n\}/) || [""])[0];
  assert(/hour:/.test(clientNowFn) && /localTime:/.test(clientNowFn),
    "buildClientNow no longer sends the time of day — the server is back to knowing the weekday and nothing else");
  assert(/tz:/.test(clientNowFn),
    "buildClientNow no longer sends the timezone, so the hour it sends is ambiguous");

  // index.html is one Babel-compiled file and cannot be imported, but these
  // two helpers are plain JS with no JSX and no DOM. Lifting their source and
  // evaluating it tests the actual behavior instead of matching on text — a
  // text match is what let three earlier versions of these assertions survive
  // the bug being reintroduced.
  const lift = (name) =>
    (indexSrc.match(new RegExp("function " + name + "\\([\\s\\S]*?\\n\\}")) || [""])[0];
  const parseSrc  = lift("parsePostTimeHM");
  const passedSrc = lift("postTimeHasPassed");
  assert(parseSrc && passedSrc,
    "index.html lost parsePostTimeHM or postTimeHasPassed — plans generated before the prompt fix have no backstop at all");
  if (parseSrc && passedSrc) {
    const hasPassed = new Function(
      parseSrc + "\n" + passedSrc + "\nreturn postTimeHasPassed;"
    )();
    const at = (h, m) => { const d = new Date(2026, 7, 7, h, m, 0, 0); return d; };

    // The exact case Lauren reported: plan generated at 10am, card says 7am
    // today.
    assert(hasPassed({ day: "Day 1 - Fri", postTime: "7:00 AM" }, at(10, 0)) === true,
      "a Day 1 card scheduled for 7am is not flagged at 10am — the reported bug is unguarded");
    assert(hasPassed({ day: "Day 1 - Fri", postTime: "7:00 PM" }, at(10, 0)) === false,
      "a Day 1 card later today is wrongly flagged as passed");
    // Only Day 1 can be in the past; every later label is a future date, and
    // flagging those would make the indicator noise within a day.
    assert(hasPassed({ day: "Day 3 - Sun", postTime: "7:00 AM" }, at(10, 0)) === false,
      "a future day's card is flagged as passed — the indicator would fire on most of the week");
    assert(hasPassed({ day: "Day 1 - Fri" }, at(10, 0)) === false,
      "a card with no postTime is flagged as passed");
  }

  // And the result has to reach the screen. Pinned to the actual render guard:
  // a looser match survived `false && postTimeHasPassed(card)`.
  assert(/card\.postTime && postTimeHasPassed\(card\)/.test(indexSrc),
    "the card no longer renders postTimeHasPassed's result — measured is not surfaced");
  assert(/window passed/.test(indexSrc),
    "the past-window indicator no longer renders on the card");
}

// ── Layer 6: the trend pipeline has a source ────────────────────────────────
//
// Two trend pipelines ran side by side and only one fed generation. The
// observed one (`trend_items`) is written solely by the ingest-trends edge
// function, whose only adapter does nothing without a paid token — so it sat
// empty. The editorial one (`trends`) was researched and paid for weekly and
// read by nothing on the server. Result: every surface got the "no trends"
// empty state while the research bill kept arriving, and the trends the
// creator saw on the Algo tab had no connection to their plan.
//
// trend-context.js reads env at module scope and talks to Supabase over
// `fetch`, so this stubs both and imports it dynamically.
{
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://fixture.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "fixture-key";
  const { buildTrendContext } = await import("../api/_lib/trend-context.js");

  const isoDay = (d) => new Date(Date.now() - d * DAY).toISOString();

  const OBSERVED_ROW = {
    platform: "instagram", type: "sound", display_name: "OBSERVED_FIXTURE_SOUND",
    status: "rising", context: "A rising audio.", suggested_angles: ["use it on a tour"],
    niche_scores: { real_estate: 0.9 }, last_seen: isoDay(1), external_url: null,
  };
  const LEGACY_ROWS = [
    { platform: "Instagram", fetched_at: isoDay(3), summary: "s", items: [
      { trend: "LEGACY_IG_ONE", category: "format", source_url: "https://example.com/a", reason: "Because A." },
      { trend: "LEGACY_IG_TWO", category: "hook",   source_url: "https://example.com/b", reason: "Because B." },
      { trend: "LEGACY_IG_THREE", category: "topic" },
      { trend: "LEGACY_IG_FOUR", category: "topic" },
      { trend: "LEGACY_IG_FIVE", category: "topic" },
      { trend: "LEGACY_IG_SIX", category: "topic" },
    ] },
    { platform: "TikTok", fetched_at: isoDay(4), summary: "s", items: [
      { trend: "LEGACY_TT_ONE", category: "audio", source_url: "https://example.com/c" },
    ] },
  ];
  const PLAYBOOK_ROW = [{ content: "IG playbook body", niche_notes: {}, version: 1 }];

  // Records every path requested so a test can assert the legacy table is NOT
  // hit on the healthy path.
  function stubFetch({ observed, legacy, playbook }) {
    const seen = [];
    globalThis.fetch = async (url) => {
      const u = String(url);
      seen.push(u);
      const body =
        u.includes("/trend_items?")        ? observed :
        u.includes("/trends?")             ? legacy :
        u.includes("/platform_playbooks?") ? (playbook === false ? [] : PLAYBOOK_ROW) :
        u.includes("/playbook_segments?")  ? [{ label: "Real Estate", compliance_overlay: "", platform_priority: [] }] :
        [];
      return { ok: true, json: async () => body };
    };
    return seen;
  }
  const realFetch = globalThis.fetch;
  const opts = { platforms: ["Instagram"], niche: "Real Estate", profile: {} };

  // 1. Observed data present → used, and the legacy table is never queried.
  {
    const seen = stubFetch({ observed: [OBSERVED_ROW], legacy: LEGACY_ROWS });
    const ctx = await buildTrendContext(opts);
    assert(ctx.block.includes("OBSERVED_FIXTURE_SOUND"),
      "observed trend data no longer reaches the block");
    assert(!ctx.block.includes("LEGACY_IG_ONE"),
      "legacy research leaked into the block while observed data existed — this is a fallback, not a merge");
    assert(!seen.some((u) => u.includes("/trends?")),
      "the legacy table was queried even though observed data existed — the healthy path should pay no extra round trip");
  }

  // 2. Observed empty, legacy present → the paid-for research reaches the model.
  {
    stubFetch({ observed: [], legacy: LEGACY_ROWS });
    const ctx = await buildTrendContext(opts);
    assert(ctx.block.includes("LEGACY_IG_ONE"),
      "observed pipeline is empty and the weekly research still never reaches the prompt — the connection is broken again");
    assert(ctx.usedTrends === true,
      "fallback trends reached the prompt but usedTrends says otherwise");
    assert(/CURRENT TRENDS as of \d{4}-\d{2}-\d{2}/.test(ctx.block),
      "the fallback block carries no 'as of' date, so the creator cannot judge its age");
    assert(/PROVENANCE/.test(ctx.block),
      "the fallback block does not state that it is editorial research rather than observed measurement");
    assert(!/status rising|status peaking/.test(ctx.block),
      "the fallback block asserts a lifecycle status the legacy rows do not carry — that is an invented claim");

    // The snapshot contract. The client's verifier builds its allow-list from
    // items[].display_name and strips any cited trend missing from it — so
    // fallback items absent here would make the scrub delete the very trends
    // this prompt supplied.
    const names = (ctx.snapshot.items || []).map((i) => i.display_name);
    assert(names.includes("LEGACY_IG_ONE"),
      "fallback trends are in the block but not in snapshot.items — the client verifier would strip every one of them from the plan");
    assert(ctx.snapshot.items.every((i) => i.status === null),
      "fallback snapshot items claim a lifecycle status the source does not provide");
    assert(ctx.snapshot.items.length <= 5,
      `fallback returned ${ctx.snapshot.items.length} items — the block is capped at 5`);
    // Unlike the observed path, the fallback does NOT add TikTok as an
    // always-on cross-platform source: the legacy rows are platform-global
    // editorial research with no niche scoring, so borrowing across platforms
    // would stack a second layer of imprecision on the first.
    assert(!names.includes("LEGACY_TT_ONE"),
      "an Instagram-only request pulled a TikTok legacy row — the fallback should not borrow across platforms");
  }

  // 2b. Multi-platform request → both platforms represented, capped at 5.
  //     Instagram alone offers six items, so a naive slice would bury TikTok.
  {
    stubFetch({ observed: [], legacy: LEGACY_ROWS });
    const ctx = await buildTrendContext({ platforms: ["Instagram", "TikTok"], niche: "Real Estate", profile: {} });
    const names = (ctx.snapshot.items || []).map((i) => i.display_name);
    assert(names.length <= 5, `fallback returned ${names.length} items — capped at 5`);
    assert(names.includes("LEGACY_TT_ONE"),
      "the single TikTok item was crowded out by Instagram's six — items are not interleaved across platforms");
    assert(names.includes("LEGACY_IG_ONE"),
      "interleaving dropped the requested platform's own top item");
  }

  // 3. Both empty → the named empty state, not silence and not a false claim.
  {
    stubFetch({ observed: [], legacy: [] });
    const ctx = await buildTrendContext(opts);
    assert(/No current trend meets this creator's bar/.test(ctx.block),
      "with both sources dry the block does not name the absence");
    assert(ctx.usedTrends === false,
      "usedTrends is true with no trends from either source");
  }

  // 4. A legacy row for a platform this request didn't ask for must not leak in.
  {
    stubFetch({ observed: [], legacy: [{ platform: "Pinterest", fetched_at: isoDay(2), items: [{ trend: "LEGACY_PIN", category: "topic" }] }] });
    const ctx = await buildTrendContext(opts);
    assert(!ctx.block.includes("LEGACY_PIN"),
      "a legacy row for an unrequested platform reached an Instagram prompt");
  }

  globalThis.fetch = realFetch;
}

// The research prompt's own source list. Naming recap publications anchors the
// model to them, and they aggregate each other — which is the mechanism behind
// "every week's trends look the same."
{
  const researchSrc = readFileSync(new URL("../api/_lib/trends-research.js", import.meta.url), "utf8");
  const hints = (researchSrc.match(/const SOURCE_HINTS_GENERAL = \[[\s\S]*?\];/) || [""])[0];
  for (const pub of ["sproutsocial", "hootsuite", "buffer.com", "socialmediaexaminer"]) {
    assert(!hints.includes(pub),
      `${pub} is back in SOURCE_HINTS_GENERAL — recap publications anchor the research to the same trends every week`);
  }
  assert(/reddit\.com/.test(hints),
    "the research prompt no longer points at primary venues where the niche conversation actually happens");
  assert(/AVOID social-media-marketing recap publications/.test(researchSrc),
    "the research prompt no longer tells the model to avoid recap publications as primary evidence");
}

// ── Layer 7: a dark trend pipeline reaches a human ─────────────────────────
//
// The observed ingest stopped writing on 2026-07-30 and nobody found out for
// eight days. The edge function's fail-soft branch behaved as designed — log,
// write nothing, return 200 — which is right for one bad run and silent for
// eight in a row. Same defect class as the playbook cron alerting only on
// success, and it cost a week of trend grounding.
{
  const healthSrc = readFileSync(new URL("../api/cron/trend-health.js", import.meta.url), "utf8");
  const tplSrc    = readFileSync(new URL("../api/_lib/email-templates.js", import.meta.url), "utf8");
  const vercelCfg = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

  // A check that never runs is not a check.
  const cronPaths = (vercelCfg.crons || []).map((c) => c.path);
  assert(cronPaths.includes("/api/cron/trend-health"),
    "trend-health is not scheduled in vercel.json — the monitor exists but never runs");
  const sched = (vercelCfg.crons || []).find((c) => c.path === "/api/cron/trend-health");
  assert(sched && /^\S+ \S+ \* \* \*$/.test(sched.schedule),
    `trend-health must run daily to catch a stale pipeline before the 7-day floor; schedule is "${sched && sched.schedule}"`);

  assert(/export function trendPipelineStale/.test(tplSrc),
    "the stale-pipeline email template is gone");

  // The handler is importable, so these two are checked by RUNNING it rather
  // than by matching source text. Both were text assertions first, and both
  // survived their mutation — `false && cronAuthorized(...)` and
  // `false && await sendEmail(...)` still contain the strings.
  {
    process.env.CRON_SECRET = process.env.CRON_SECRET || "fixture-cron-secret";
    process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "fixture-resend-key";
    const { default: trendHealth } = await import("../api/cron/trend-health.js");

    const mockRes = () => {
      const out = {};
      const r = {
        status(code) { out.code = code; return r; },
        json(body) { out.body = body; return r; },
      };
      return { r, out };
    };
    const staleIso = new Date(Date.now() - 30 * DAY).toISOString();
    const realFetch2 = globalThis.fetch;
    const hits = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      hits.push(u);
      if (u.includes("/trend_items?")) return { ok: true, json: async () => [{ last_seen: staleIso }] };
      if (u.includes("/trends?")) return { ok: true, json: async () =>
        ["TikTok", "Instagram", "Facebook", "YouTube", "LinkedIn", "X", "Pinterest"]
          .map((pf) => ({ platform: pf, fetched_at: staleIso })) };
      if (u.includes("/auth/v1/admin/users")) return { ok: true, json: async () => ({ users: [{ id: "u1" }] }) };
      // 409 = "already claimed" — proves sendEmail ran without reaching Resend.
      if (u.includes("/email_sends")) return { ok: false, status: 409, text: async () => "" };
      return { ok: true, json: async () => [] };
    };

    // Unauthorized request must be rejected outright.
    {
      const { r, out } = mockRes();
      await trendHealth({ headers: {} }, r);
      assert(out.code === 401,
        `trend-health answered an unauthenticated request with ${out.code} — the CRON_SECRET gate is not enforced`);
    }

    // Authorized + both pipelines long dead → reports it AND actually sends.
    {
      hits.length = 0;
      const { r, out } = mockRes();
      await trendHealth({ headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, r);
      assert(out.code === 200, `trend-health returned ${out.code} on an authorized request`);
      assert(out.body && out.body.observedStale === true && out.body.legacyStale === true && out.body.bothDark === true,
        `a 30-day-old pipeline was not reported stale: ${JSON.stringify(out.body)}`);
      assert(hits.some((u) => u.includes("/email_sends")),
        "trend-health detected a dark pipeline and never attempted an email — a monitor that only returns JSON repeats the exact failure it exists to fix");
    }

    // ONE platform lagging while the rest refresh. This is the case a global
    // max(fetched_at) misses entirely — and the case the live data actually
    // showed, with LinkedIn one weekly run behind every other platform.
    // Creators on the lagging platform go dark; the monitor must not be
    // reassured by the six healthy ones.
    {
      const freshIso = new Date(Date.now() - 1 * DAY).toISOString();
      const lateIso  = new Date(Date.now() - 30 * DAY).toISOString();
      globalThis.fetch = async (url) => {
        const u = String(url);
        hits.push(u);
        if (u.includes("/trend_items?")) return { ok: true, json: async () => [{ last_seen: freshIso }] };
        if (u.includes("/trends?")) return { ok: true, json: async () => [
          { platform: "TikTok", fetched_at: freshIso },
          { platform: "Instagram", fetched_at: freshIso },
          { platform: "Facebook", fetched_at: freshIso },
          { platform: "YouTube", fetched_at: freshIso },
          { platform: "X", fetched_at: freshIso },
          { platform: "Pinterest", fetched_at: freshIso },
          { platform: "LinkedIn", fetched_at: lateIso },
        ] };
        if (u.includes("/auth/v1/admin/users")) return { ok: true, json: async () => ({ users: [{ id: "u1" }] }) };
        if (u.includes("/email_sends")) return { ok: false, status: 409, text: async () => "" };
        return { ok: true, json: async () => [] };
      };
      hits.length = 0;
      const { r, out } = mockRes();
      await trendHealth({ headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, r);
      assert(out.body && out.body.legacyStale === true,
        "one platform 30 days behind six fresh ones was reported healthy — the check is reading a global max instead of the worst platform");
      assert(out.body && Array.isArray(out.body.laggingPlatforms) && out.body.laggingPlatforms.includes("LinkedIn"),
        `the lagging platform is not named: ${JSON.stringify(out.body && out.body.laggingPlatforms)}`);
      assert(out.body.laggingPlatforms.length === 1,
        `a single lagging platform dragged ${out.body.laggingPlatforms.length} into the report`);
      // The reported age must be the WORST platform, not the best. Reporting
      // the freshest is how a global max hides a dark channel in the first
      // place, and it would put a reassuring "1 day old" in the email.
      assert(out.body.legacyAgeDays === 30,
        `reported legacy age is ${out.body.legacyAgeDays} — it should be the worst platform (30), not the healthiest`);
      assert(hits.some((u) => u.includes("/email_sends")),
        "a platform going dark for 30 days sent no email");
    }

    // A platform absent from the table entirely is dark, not unknown.
    {
      const freshIso = new Date(Date.now() - 1 * DAY).toISOString();
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/trend_items?")) return { ok: true, json: async () => [{ last_seen: freshIso }] };
        if (u.includes("/trends?")) return { ok: true, json: async () =>
          ["TikTok", "Instagram", "Facebook", "YouTube", "X", "LinkedIn"]
            .map((p) => ({ platform: p, fetched_at: freshIso })) };  // no Pinterest row at all
        if (u.includes("/auth/v1/admin/users")) return { ok: true, json: async () => ({ users: [{ id: "u1" }] }) };
        if (u.includes("/email_sends")) return { ok: false, status: 409, text: async () => "" };
        return { ok: true, json: async () => [] };
      };
      const { r, out } = mockRes();
      await trendHealth({ headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, r);
      assert(out.body && out.body.laggingPlatforms.includes("Pinterest"),
        "a platform with no research rows at all was not reported — never-researched reads the same to a creator as long-stale");
    }

    // Healthy pipelines → no alert. A monitor that cries every day gets muted,
    // and a muted monitor is the eight-day outage again.
    {
      const freshIso = new Date(Date.now() - 1 * DAY).toISOString();
      globalThis.fetch = async (url) => {
        const u = String(url);
        hits.push(u);
        if (u.includes("/trend_items?")) return { ok: true, json: async () => [{ last_seen: freshIso }] };
        if (u.includes("/trends?")) return { ok: true, json: async () =>
          ["TikTok", "Instagram", "Facebook", "YouTube", "LinkedIn", "X", "Pinterest"]
            .map((pf) => ({ platform: pf, fetched_at: freshIso })) };
        if (u.includes("/auth/v1/admin/users")) return { ok: true, json: async () => ({ users: [{ id: "u1" }] }) };
        if (u.includes("/email_sends")) return { ok: false, status: 409, text: async () => "" };
        return { ok: true, json: async () => [] };
      };
      hits.length = 0;
      const { r, out } = mockRes();
      await trendHealth({ headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, r);
      assert(out.body && out.body.observedStale === false && out.body.legacyStale === false,
        `fresh pipelines were reported stale: ${JSON.stringify(out.body)}`);
      assert(!hits.some((u) => u.includes("/email_sends")),
        "trend-health emailed about a healthy pipeline — a daily false alarm is how a real alert gets ignored");
    }

    globalThis.fetch = realFetch2;
  }

  // The load-bearing numeric relationship. Generation refuses trends older
  // than 7 days (TREND_FRESHNESS_DAYS in trend-context.js). If the alert
  // threshold were >= that, the email would only ever confirm an outage that
  // had already reached creators. It has to fire with runway.
  const trendCtxSrc = readFileSync(new URL("../api/_lib/trend-context.js", import.meta.url), "utf8");
  const genFloor = Number((trendCtxSrc.match(/TREND_FRESHNESS_DAYS\s*=\s*(\d+)/) || [])[1]);
  const observedThreshold = Number((healthSrc.match(/OBSERVED_STALE_DAYS\s*=\s*(\d+)/) || [])[1]);
  const legacyThreshold = Number((healthSrc.match(/LEGACY_STALE_DAYS\s*=\s*(\d+)/) || [])[1]);
  const legacyWindow = Number((trendCtxSrc.match(/LEGACY_TREND_FRESHNESS_DAYS\s*=\s*(\d+)/) || [])[1]);

  assert(Number.isFinite(genFloor) && Number.isFinite(observedThreshold),
    "could not read the freshness floor or the alert threshold — one of them was renamed");
  assert(observedThreshold < genFloor,
    `the observed alert fires at ${observedThreshold} days but generation already refuses trends at ${genFloor} — the warning would arrive after creators went dark`);
  assert(Number.isFinite(legacyThreshold) && Number.isFinite(legacyWindow) && legacyThreshold < legacyWindow,
    `the legacy alert fires at ${legacyThreshold} days but the fallback query stops returning rows at ${legacyWindow} — same problem on the fallback path`);

  // An empty or unreadable table is the most severe form of this failure, not
  // an unknown to be skipped. (Deliberately the opposite of playbookAge, where
  // a missing timestamp means a schema gap on data that still exists.)
  assert(/observedAge === null \|\| observedAge >= OBSERVED_STALE_DAYS/.test(healthSrc),
    "an empty trend_items table does not count as stale — the worst case would go unreported");

  // Both dry is the state creators actually feel, and the email has to say so
  // rather than describing which internal pipeline broke.
  const { trendPipelineStale } = await import("../api/_lib/email-templates.js");
  const both = trendPipelineStale({
    observedAge: 12, legacyAge: 15, observedStale: true, legacyStale: true,
    bothDark: true, observedThreshold: 5, legacyThreshold: 10,
  });
  assert(/no trend data reaching plans/i.test(both.subject),
    "the both-dark subject line does not say that plans have no trends");
  assert(/no trends this week|no trend grounding|showing the no-trends state/i.test(both.text),
    "the both-dark email does not lead with creator impact");

  const partial = trendPipelineStale({
    observedAge: 2, legacyAge: 30, observedStale: false, legacyStale: true,
    bothDark: false, laggingPlatforms: ["LinkedIn"], totalPlatforms: 7,
    observedThreshold: 5, legacyThreshold: 10,
  });
  assert(/LinkedIn/.test(partial.subject),
    "one platform stalled and the subject line doesn't name it — 'research stale' reads as all seven and sends you looking in the wrong place");
  assert(/LinkedIn/.test(partial.text),
    "the lagging platform is not named in the email body");
  const allStalled = trendPipelineStale({
    observedAge: 2, legacyAge: 30, observedStale: false, legacyStale: true,
    bothDark: false,
    laggingPlatforms: ["TikTok", "Instagram", "Facebook", "YouTube", "LinkedIn", "X", "Pinterest"],
    totalPlatforms: 7, observedThreshold: 5, legacyThreshold: 10,
  });
  assert(!/LinkedIn/.test(allStalled.subject),
    "all seven platforms stalled but the subject enumerates them — that is the whole pipeline, and it should say so");

  const observedOnly = trendPipelineStale({
    observedAge: 8, legacyAge: 4, observedStale: true, legacyStale: false,
    bothDark: false, observedThreshold: 5, legacyThreshold: 10,
  });
  assert(/fallback/i.test(observedOnly.text),
    "with only the observed pipeline stale, the email does not say the fallback is covering it — that difference decides how urgently to act");
  assert(observedOnly.subject !== both.subject,
    "a partial outage and a total one send the same subject line");
}

if (failures > 0) {
  console.error(`\nStrategist eval FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log("OK: trend grounding, niche layer, live playbook values, and staleness bounds hold on every surface.");
