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

import { dispatch } from "../api/_lib/prompts.js";
import { computeVoiceDrift, FEATURE_NORMS } from "../api/_lib/voice-drift.js";

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

// Empty-safe: a brand-new profile with no voice reference must still build a
// prompt (just with fewer blocks) and must NOT crash.
try {
  const bare = buildSystem("caption", { platform: "Instagram", topic: "x" }, { name: "New", niche: "Wellness" });
  assert(typeof bare === "string" && bare.length > 0, "bare profile produced an empty caption system prompt");
  assert(!/THE CREATOR'S OWN WRITING/.test(bare), "bare profile should not emit an own-writing block");
} catch (e) {
  assert(false, `bare profile build threw — ${e && e.message}`);
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
