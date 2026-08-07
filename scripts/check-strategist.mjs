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

if (failures > 0) {
  console.error(`\nStrategist eval FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log("OK: trend grounding, niche layer, live playbook values, and staleness bounds hold on every surface.");
