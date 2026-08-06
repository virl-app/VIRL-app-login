// scripts/check-voice.mjs
//
// [VOICE-EVAL] Deterministic, no-network regression net for voice fidelity.
// Catches the class of bug that has actually shipped here before — a voice
// signal present on some generation surfaces but silently missing on others
// (e.g. Plan generated with no STYLE_GUARD and no personal facts), and the
// em-dash rule quietly loosening — WITHOUT calling the LLM (CI must be
// deterministic, free, and secret-free).
//
// Two layers:
//   A. Prompt-assembly invariants — assemble the real system prompt for every
//      generation surface via prompts.js `dispatch`, and assert the whole
//      voice stack is present on ALL of them.
//   B. Scorer sanity — assert voice-drift.js behaves (identical text ≈ 0
//      drift; an em-dash-heavy draft vs an em-dash-free reference registers
//      on the em-dash axis), so the drift gate it powers can't silently break.
//
// Mirrors scripts/check-compliance.mjs: Node ES module, prints OK / FAIL,
// exits 1 on any failure so CI blocks the merge.
//
// A live, LLM-in-the-loop eval (golden inputs → real generation → judge) is
// intentionally OUT of scope here — it's non-deterministic, costs money, and
// needs an API key. Run that one nightly/manually, not as a PR gate.

import { dispatch, VOICE_LEARNING_TYPES } from "../api/_lib/prompts.js";
import { computeVoiceDrift, FEATURE_NORMS } from "../api/_lib/voice-drift.js";
import { selectVaultExemplars, formatExemplarsForPrompt, exemplarsAsVoiceText } from "../api/_lib/vault-exemplars.js";
import { computePerformanceInsights } from "../api/_lib/performance-insights.js";
import { readFileSync } from "node:fs";

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures += 1;
  console.error("FAIL:", msg);
}

// A golden profile rich enough to populate every voice block: critical facts
// (a set — three kids — to exercise the relevance-gating reframe), authored
// voice reference (so the fingerprint + own-writing blocks fire), and scraped
// excerpts (the Perplexity signal that must reach the model as examples).
const GOLDEN_PROFILE = {
  name: "Lauren",
  niche: "Wellness",
  personalFacts: "Has three kids: Ava, Mia, and Noah. Runs a boutique wellness studio in Austin.",
  neverAssume: "Do not assume the audience has a gym membership.",
  loveToReference: "Early-morning routines; her studio's Sunday reset class.",
  sampleCaption: "okay but why does nobody talk about how hard mornings are with three kids under ten and a 6am class to teach",
  voiceSamples: [
    "no fluff today. just the one thing that actually moved the needle this week.",
    "i used to think rest days were lazy. turns out they're the whole strategy.",
  ],
  handlePostExcerpts: [
    "the 5am club is a lie. here's what actually works when you're exhausted.",
    "your nervous system doesn't care about your to-do list. start there.",
  ],
  handles: { instagram: "laurenwellness" },
};

// Surfaces to check. Each must produce the full voice stack. Image gen types
// don't need real image bytes — the prompt builder never sees them.
const SURFACES = [
  { label: "Plan",          gt: "plan",             params: { platforms: ["Instagram"], formats: ["video"], niche: "Wellness", goal: "growth" } },
  { label: "Plan (partial)", gt: "plan_partial",    params: { platforms: ["Instagram"], formats: ["video"], niche: "Wellness", goal: "growth", replaceSlots: [{ day: "Day 1 - Mon", platform: "Instagram", format: "video" }], strategy: {} } },
  { label: "LinkedIn post", gt: "long_post",        params: { topic: "morning routines", length: "medium" } },
  { label: "Blog post",     gt: "blog_post",        params: { topic: "morning routines", length: "medium" } },
  { label: "Caption",       gt: "caption",          params: { platform: "Instagram", topic: "morning routines" } },
  { label: "Script",        gt: "script",           params: { card: { title: "Morning reset", description: "a calm start", platform: "Instagram", format: "video" } } },
  { label: "Scan",          gt: "scan_image",       params: {} },
];

function flatten(systemPrompt) {
  if (typeof systemPrompt === "string") return systemPrompt;
  if (systemPrompt && typeof systemPrompt === "object") {
    return (systemPrompt.shared || "") + "\n" + (systemPrompt.perUser || "");
  }
  return "";
}

function buildSystem(gt, params, profile) {
  // dispatch(generationType, params, profile, vaultPatterns, playbook, trends,
  //          history, recentEdits, compliance, personalDenylist)
  const built = dispatch(gt, params, profile, null, {}, {}, [], null, null, null);
  return flatten(built.systemPrompt);
}

// ── Layer A: every surface carries the full voice stack ─────────────────────
// These are the exact signals that have silently gone missing on a surface
// before. If any assertion fails, a voice signal is no longer reaching that
// surface's prompt — the regression we're guarding against.
const REQUIRED = [
  { name: "STYLE_GUARD (em-dash discipline)", re: /Em-dashes/ },
  { name: "critical personal facts block",    re: /CRITICAL PERSONAL FACTS/ },
  { name: "relevance-gating reframe",         re: /partial subset of a set/ },
  { name: "personal facts content (kids)",    re: /Ava, Mia, and Noah/ },
  { name: "creator's own-writing examples",   re: /THE CREATOR'S OWN WRITING/ },
  { name: "own-writing shown verbatim",       re: /why does nobody talk about how hard mornings/ },
  { name: "scraped excerpt shown verbatim",   re: /5am club is a lie/ },
  // [PERSONA] The character sheet must lead EVERY generation surface. This is
  // the same silent-drop failure the voice stack above guards against: a
  // refactor that drops the persona from one surface reads fine locally and
  // ships a tool-voiced caption to that surface only. The two anchors below
  // are load-bearing lines from the C1 sheet (identity + the no-human clause).
  { name: "VIRL_PERSONA (identity line)",     re: /YOU ARE VIRL — the user's content strategist/ },
  { name: "VIRL_PERSONA (never-human clause)", re: /never pretend otherwise/ },
];

for (const s of SURFACES) {
  let sys = "";
  try {
    sys = buildSystem(s.gt, s.params, GOLDEN_PROFILE);
  } catch (e) {
    assert(false, `${s.label} (${s.gt}): prompt build threw — ${e && e.message}`);
    continue;
  }
  for (const req of REQUIRED) {
    assert(req.re.test(sys), `${s.label} (${s.gt}): missing ${req.name}`);
  }
}

// [PERSONA] Register split — the boundary that keeps VIRL's strategist voice
// out of publishable copy — must reach every surface that emits creator copy.
// Its absence is how a caption ends up saying "my call is Instagram" in the
// creator's feed. Anchor on the block's headline sentence.
for (const s of SURFACES) {
  let sys = "";
  try { sys = buildSystem(s.gt, s.params, GOLDEN_PROFILE); } catch (e) { continue; }
  assert(/DO NOT MIX THEM/.test(sys), `${s.label} (${s.gt}): missing the two-register split`);
}

// [PERSONA] The rationale voice rules (with the SLOP/ON-VOICE calibration
// pairs) must reach the plan surface — that's where every "why this works"
// field lives, and the calibration pairs do more than the rules alone.
{
  const planParams = { platforms: ["Instagram"], formats: ["video"], niche: "Wellness", goal: "growth" };
  const planBuilt = dispatch("plan", planParams, GOLDEN_PROFILE, null, {}, {}, [], null, null, null);
  const planSys  = flatten(planBuilt.systemPrompt);
  const planUser = planBuilt.userPrompt || "";
  assert(/RATIONALE VOICE/.test(planSys),          "Plan: missing RATIONALE_RULES");
  assert(/rides the POV-tour trend/.test(planSys), "Plan: missing the ON-VOICE calibration example");
  assert(/silently review your draft/.test(planSys), "Plan: missing SELF_CHECK_RUBRIC");
  // The structural trend rule rides the USER prompt (via planTrendsContext),
  // and with no trends passed it must emit the explicit empty-state form.
  assert(/TREND GROUNDING — STRUCTURAL/.test(planUser), "Plan: missing structural trend-grounding rule");
  assert(/no trend research is available/.test(planUser), "Plan: missing trend empty-state (no-research) instruction");
}

// Empty-safe: a brand-new profile with no voice reference must still build a
// prompt (just with fewer blocks) and must NOT crash.
try {
  const bare = buildSystem("caption", { platform: "Instagram", topic: "x" }, { name: "New", niche: "Wellness" });
  assert(typeof bare === "string" && bare.length > 0, "bare profile produced an empty caption system prompt");
  assert(!/THE CREATOR'S OWN WRITING/.test(bare), "bare profile should not emit an own-writing block");
} catch (e) {
  assert(false, `bare profile build threw — ${e && e.message}`);
}

// ── Layer A2: learned signals reach every surface that claims them ──────────
//
// [VOICE-LEARNING] The checks above cover the STATIC voice stack — persona,
// style guard, personal facts. This covers the LEARNED signals: what the
// creator has edited, and what they've flagged as off.
//
// This is the assertion that would have caught the bug it was written for.
// long_post and blog_post sat in the fetch list in chat.js, with comments
// explaining that voice fidelity mattered most on exactly those surfaces,
// while their builders took the diffs as `_recentEdits` and discarded them.
// Every generation paid for the query; none of them used the answer; nothing
// anywhere said so. Two lists that had to agree, and no check that they did.
//
// Now there is one list — VOICE_LEARNING_TYPES — and this walks it. A type
// added to the set without wiring its builder fails here, as does a builder
// that quietly stops consuming the signal.
{
  const LEARNING_PARAMS = {
    plan:             { platforms: ["Instagram"], formats: ["video"], niche: "Wellness", goal: "growth" },
    plan_partial:     { platforms: ["Instagram"], formats: ["video"], niche: "Wellness", goal: "growth", replaceSlots: [{ day: "Day 1 - Mon", platform: "Instagram", format: "video" }], strategy: {} },
    caption:          { platform: "Instagram", topic: "morning routines" },
    caption_remix:    { platform: "Instagram", topic: "morning routines", originalCaption: "mornings are hard with three kids" },
    scan_image:       {},
    scan_video_frame: {},
    long_post:        { topic: "morning routines", length: "medium" },
    blog_post:        { topic: "morning routines", length: "medium" },
    script:           { card: { title: "Morning reset", description: "a calm start", platform: "Instagram", format: "video" } },
  };

  const EDITS = [{ field: "hook", before: "Discover the transformative power of morning routines", after: "my mornings are chaos", surface: "caption" }];
  const PROFILE_WITH_REACTIONS = Object.assign({}, GOLDEN_PROFILE, {
    voiceReactions: [{ reason: "Too formal", count: 3, lastAt: "2026-07-27T10:00:00Z", lastType: "caption" }],
  });

  for (const gt of VOICE_LEARNING_TYPES) {
    const params = LEARNING_PARAMS[gt];
    // A type in the set with no fixture here is itself a failure: it means
    // someone widened the set without teaching the gate how to exercise it.
    if (!params) {
      assert(false, `${gt}: in VOICE_LEARNING_TYPES but has no fixture in check-voice.mjs — add one`);
      continue;
    }
    let text = "";
    try {
      const built = dispatch(gt, params, PROFILE_WITH_REACTIONS, null, {}, {}, [], EDITS, null, null);
      // The blocks ride the user prompt on some surfaces and the system
      // prompt on others; both are the model's input, so check the pair.
      text = flatten(built.systemPrompt) + "\n" + (built.userPrompt || "");
    } catch (e) {
      assert(false, `${gt}: prompt build threw while checking learned signals — ${e && e.message}`);
      continue;
    }
    assert(/HOW THIS CREATOR REVISES VIRL DRAFTS/.test(text),
      `${gt}: in VOICE_LEARNING_TYPES but its prompt carries no edit-diff block`);
    assert(/my mornings are chaos/.test(text),
      `${gt}: edit-diff block present but the actual diff text is missing`);
    assert(/WHAT THIS CREATOR HAS FLAGGED AS OFF/.test(text),
      `${gt}: in VOICE_LEARNING_TYPES but its prompt carries no reaction block`);
  }

  // The inverse: a type deliberately EXCLUDED must stay excluded, so the
  // exclusions in VOICE_LEARNING_TYPES stay decisions rather than drifting
  // into accidents. plan_strategy emits strategic direction, never creator
  // copy — learned voice signal has no business there.
  assert(!VOICE_LEARNING_TYPES.has("plan_strategy"),
    "plan_strategy should stay out of VOICE_LEARNING_TYPES — it emits strategy, not creator copy");
  {
    const built = dispatch("plan_strategy", {
      platforms: ["Instagram"], niche: "Wellness", goal: "growth",
      cards: [{ day: "Day 1 - Mon", title: "Morning reset", platform: "Instagram", format: "video" }],
    }, PROFILE_WITH_REACTIONS, null, {}, {}, [], EDITS, null, null);
    const text = flatten(built.systemPrompt) + "\n" + (built.userPrompt || "");
    assert(!/HOW THIS CREATOR REVISES VIRL DRAFTS/.test(text),
      "plan_strategy: excluded from VOICE_LEARNING_TYPES but still emitting the edit-diff block");
  }
}

// ── Layer A3: exemplars carry the CREATOR's register, not VIRL's ────────────
//
// [EXEMPLAR-REGISTER] Every assertion above passed `null` for vaultPatterns,
// so this gate could not observe the exemplar block or the performance block
// on any surface — which is precisely how the bug below survived: the pool
// builder read `description` (VIRL's strategic one-liner, listed in the VIRL
// column of PLAN_REGISTER_SPLIT), rendered it to the model labelled
// "Caption:", and fed it into the drift reference. The block whose entire job
// is showing the model how the creator sounds was showing it how VIRL sounds,
// and the drift gate was partly calibrated on VIRL's register.
//
// The fixtures below deliberately put DISTINCT, unmistakable text in each
// register so a regression can't hide behind a plausible-looking string.
{
  const VIRL_VOICE   = "Spotlight the studio renovation to hook local first-timers.";
  const CREATOR_VOICE = "we ripped out the old floors at 6am and i have never been so tired or so happy";
  const CREATOR_HOOK  = "nobody warned me about the floor situation";

  const VAULT_ROWS = [{
    id: "card-1",
    title: "Studio reveal",
    platform: "Instagram",
    format: "video",
    savedAt: "2026-07-20T10:00:00Z",
    description: VIRL_VOICE,     // VIRL's register — must never reach the model as voice
    caption:     CREATOR_VOICE,  // the creator's register — this is the exemplar
    hook:        CREATOR_HOOK,
  }];
  const RESULT_ROWS = [{
    id: "card-1",
    title: "Studio reveal",
    platform: "Instagram",
    format: "video",
    loggedAt: "2026-07-22T10:00:00Z",
    description: VIRL_VOICE,
    caption:     CREATOR_VOICE,
    hook:        CREATOR_HOOK,
    result: { views: 4200, likes: 310, saves: 88 },
  }];

  const exemplars = selectVaultExemplars(VAULT_ROWS, RESULT_ROWS, 5);
  assert(exemplars.length > 0, "exemplar pool came back empty for a fully-populated vault row");

  const rendered = formatExemplarsForPrompt(exemplars);
  assert(rendered.includes(CREATOR_VOICE),
    "exemplar block does not render the creator's caption — the voice reference is empty or wrong-register");
  assert(!rendered.includes(VIRL_VOICE),
    "exemplar block renders VIRL's `description` as the creator's caption — the register inversion is back");

  // The same text becomes the drift gate's ground truth via chat.js
  // buildVoiceReference. If VIRL's register leaks here, the gate enforces
  // TOWARD VIRL and every downstream voice fix makes output worse.
  const driftCorpus = exemplarsAsVoiceText(exemplars);
  assert(driftCorpus.includes(CREATOR_VOICE),
    "drift reference corpus is missing the creator's own caption");
  assert(!driftCorpus.includes(VIRL_VOICE),
    "drift reference corpus contains VIRL's strategist prose — the gate would enforce toward VIRL's voice");

  // A row carrying ONLY VIRL's description contributes nothing as voice.
  // `description` is deliberately not a fallback: no exemplar is better than
  // a wrong-register one.
  const descOnly = selectVaultExemplars([{ id: "d1", description: VIRL_VOICE, savedAt: "2026-07-20T10:00:00Z" }], [], 5);
  assert(descOnly.length === 0,
    "a vault row with only VIRL's `description` produced an exemplar — description must not be a voice fallback");

  // And the whole thing has to survive the trip through every surface that
  // receives vaultPatterns, including Scan, which emits publishable creator
  // copy and was excluded from the voice fetch entirely.
  const VAULT_PATTERNS = {
    count: 1,
    topPlatform: "Instagram",
    topFormat: "video",
    exemplars,
    optimalDays: {},
    performanceInsights: computePerformanceInsights(VAULT_ROWS, RESULT_ROWS),
  };
  const EXEMPLAR_SURFACES = [
    { label: "Plan",     gt: "plan",             params: { platforms: ["Instagram"], formats: ["video"], niche: "Wellness", goal: "growth" } },
    { label: "Caption",  gt: "caption",          params: { platform: "Instagram", topic: "morning routines" } },
    { label: "Script",   gt: "script",           params: { card: { title: "Morning reset", description: "a calm start", platform: "Instagram", format: "video" } } },
    { label: "LinkedIn", gt: "long_post",        params: { topic: "morning routines", length: "medium" } },
    { label: "Blog",     gt: "blog_post",        params: { topic: "morning routines", length: "medium" } },
    { label: "Scan",     gt: "scan_image",       params: {} },
    { label: "Scan (video)", gt: "scan_video_frame", params: {} },
  ];
  for (const s of EXEMPLAR_SURFACES) {
    let text = "";
    try {
      const built = dispatch(s.gt, s.params, GOLDEN_PROFILE, VAULT_PATTERNS, {}, {}, [], null, null, null);
      text = flatten(built.systemPrompt) + "\n" + (built.userPrompt || "");
    } catch (e) {
      assert(false, `${s.label} (${s.gt}): build threw with vaultPatterns supplied — ${e && e.message}`);
      continue;
    }
    assert(text.includes(CREATOR_VOICE),
      `${s.label} (${s.gt}): receives vaultPatterns but the creator's caption never reaches the prompt`);
    assert(!text.includes(VIRL_VOICE),
      `${s.label} (${s.gt}): VIRL's strategist description reached the prompt as creator voice`);
  }
}

// ── Layer B: the drift scorer (powers the drift gate) behaves ───────────────
const REF = "okay so here's the thing. mornings are hard, and i'm not gonna pretend they're not. but you can do this, one small step at a time, and honestly that's more than enough for today.";
const SAME = computeVoiceDrift(REF, REF);
assert(SAME && SAME.score === 0, `identical text should score 0 drift, got ${SAME && SAME.score}`);

// An em-dash-saturated, formal, long-sentence draft vs. the casual reference
// must register clear drift, and the em-dash axis specifically must move.
const DRIFTED = "Mornings represent a profound opportunity — a canvas — upon which one may inscribe intention, discipline, and the architecture of a life well-lived — provided, of course, that one rises with sufficient resolve.";
const DRIFT = computeVoiceDrift(DRIFTED, REF);
assert(DRIFT && DRIFT.score > 0, "a clearly off-voice draft should score > 0 drift");
assert(DRIFT && DRIFT.deltas && DRIFT.deltas.emdashRate > 0, "em-dash-heavy draft should move the emdashRate axis");

// FEATURE_NORMS export (single source of truth shared with the gate) intact.
assert(FEATURE_NORMS && typeof FEATURE_NORMS.emdashRate === "number", "FEATURE_NORMS.emdashRate must be exported as a number");

if (failures > 0) {
  console.error(`\nVoice eval FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log("OK: voice stack present on all surfaces + drift scorer sane.");
