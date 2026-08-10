// scripts/check-trend-personalization.mjs
//
// [TREND-PERSONALIZATION] Regression net for trend SELECTION — the layer that
// decides which trends a creator is shown, as opposed to how they are written.
//
// This guards a filter that DELETES trends. That asymmetry is the whole reason
// the file exists: a scoring bug shows up as slightly worse ordering, but a
// matching bug in the off-limits filter shows up as an empty trend block, and
// the pipeline is fail-open by design, so an empty block renders as the
// perfectly normal "no trends this week" state on every surface. It would look
// exactly like a quiet week — the same disguise the billing lapse wore.
//
// So the assertions come in pairs: each one that proves a boundary IS enforced
// is matched by one proving nothing else was taken with it.
//
//   node scripts/check-trend-personalization.mjs

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://stub.local";
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "stub";

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures += 1;
  console.error("FAIL:", msg);
}

// ── Stub Supabase ──────────────────────────────────────────────────────────
// trend-context.js issues several PostgREST reads in one Promise.all. Route by
// table name and return only what each assertion needs.

function trendRow(displayName, extra = {}) {
  return {
    platform: "tiktok",
    type: "sound",
    display_name: displayName,
    external_url: "https://www.tiktok.com/music/x-1",
    status: "rising",
    context: extra.context || "",
    suggested_angles: [],
    niche_scores: { real_estate: 0.9 },
    last_seen: new Date().toISOString(),
    ...extra,
  };
}

let OBSERVED = [];
let LEGACY = [];

globalThis.fetch = async (url) => {
  const u = String(url);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  if (u.includes("/trend_items")) return ok(OBSERVED);
  if (u.includes("/trends?")) return ok(LEGACY);
  if (u.includes("/playbook_segments")) return ok([{ label: "Real Estate", compliance_overlay: "", platform_priority: null }]);
  if (u.includes("/platform_playbooks")) return ok([{ content: "PLAYBOOK BODY", niche_notes: {}, version: 1 }]);
  return ok([]);
};

const { buildTrendContext } = await import("../api/_lib/trend-context.js");

const BASE = { platforms: ["TikTok"], niche: "Real Estate" };

// ── 1. Off-limits is enforced on the observed path ─────────────────────────

OBSERVED = [
  trendRow("Election Day POV sound", { context: "creators posting about the election" }),
  trendRow("Kitchen reveal transition"),
];
LEGACY = [];

let r = await buildTrendContext({
  ...BASE,
  profile: { offLimits: "politics, elections" },
});
assert(!r.block.includes("Election Day POV"),
  "off-limits term 'elections' should remove the matching trend");
assert(r.block.includes("Kitchen reveal transition"),
  "off-limits filtering must NOT remove unrelated trends — this is the gutting case");
assert(r.snapshot && r.snapshot.items.length === 1,
  "snapshot items must match what survived the filter, or the client verifier strips the wrong things");

// ── 2. No off-limits set removes nothing ───────────────────────────────────
// The dangerous default. An empty/absent field must be inert, not a filter
// that matches everything.

for (const profile of [undefined, {}, { offLimits: "" }, { offLimits: "   " }, { offLimits: "no" }]) {
  r = await buildTrendContext({ ...BASE, profile });
  assert(r.snapshot && r.snapshot.items.length === 2,
    `empty/short offLimits (${JSON.stringify(profile)}) must not filter anything — got ` +
    ((r.snapshot && r.snapshot.items.length) ?? "no snapshot"));
}

// Short fragments are dropped deliberately: "no" as a term would substring-
// match half the trend table.
r = await buildTrendContext({ ...BASE, profile: { offLimits: "no" } });
assert(r.snapshot.items.length === 2, "sub-4-character terms must be ignored");

// ── 3. Off-limits also applies to the legacy fallback ──────────────────────
// The fallback runs precisely when the observed pipeline is dark, so a
// boundary that only held on the healthy path would fail exactly when it
// mattered.

OBSERVED = [];
LEGACY = [{
  platform: "TikTok",
  fetched_at: new Date().toISOString(),
  summary: "",
  items: [
    { trend: "Agents debating the election's effect on rates", category: "topic", source_url: "https://example.com/a", reason: "" },
    { trend: "Twilight listing photo trend", category: "format", source_url: "https://example.com/b", reason: "" },
  ],
}];

r = await buildTrendContext({ ...BASE, profile: { offLimits: "politics, elections" } });
assert(!r.block.includes("debating the election"),
  "off-limits must filter the LEGACY fallback too, not only the observed path");
assert(r.block.includes("Twilight listing photo"),
  "legacy filtering must leave unrelated fallback items intact");

// ── 3b. Segment rows beat global rows, and the wording follows ─────────────
// [TRENDS-SEGMENT] The defect: a real estate agent's plan built on general
// TikTok culture, under a prompt line asserting it was her industry. Both
// halves are asserted here — the right row wins, AND the claim made about it
// matches where it came from.

OBSERVED = [];
const globalRow = {
  platform: "TikTok", segment: null, fetched_at: new Date().toISOString(), summary: "",
  items: [{ trend: "The Microwave Challenge is a behavior-led challenge", category: "format", source_url: "https://example.com/g", reason: "" }],
};
const segmentRow = {
  platform: "TikTok", segment: "real_estate",
  // Deliberately OLDER than the global row: inside the freshness window, being
  // about her business beats being published this morning.
  fetched_at: new Date(Date.now() - 3 * 86400000).toISOString(), summary: "",
  items: [{ trend: "Agents posting sub-60s twilight walkthroughs", category: "format", source_url: "https://example.com/s", reason: "" }],
};

LEGACY = [globalRow, segmentRow];
r = await buildTrendContext({ ...BASE, profile: {} });
assert(r.block.includes("twilight walkthroughs"),
  "a segment row must win over a global row for the same platform");
assert(!r.block.includes("Microwave Challenge"),
  "the global row must not also be served once a segment row exists");
assert(r.block.includes("researched for this creator's industry"),
  "provenance should claim niche relevance when the rows ARE niche-researched");

// Order-independence. Rows arrive newest-first, so which tier appears first
// depends on publish times — the preference must not.
LEGACY = [segmentRow, globalRow];
r = await buildTrendContext({ ...BASE, profile: {} });
assert(r.block.includes("twilight walkthroughs") && !r.block.includes("Microwave Challenge"),
  "segment preference must hold regardless of row order");

// Global-only: the claim must weaken to match.
LEGACY = [globalRow];
r = await buildTrendContext({ ...BASE, profile: {} });
assert(r.block.includes("Microwave Challenge"),
  "global rows must still serve when no segment row exists — this is the fallback's fallback");
assert(r.block.includes("PLATFORM-WIDE research"),
  "provenance must say platform-wide when serving global rows, not claim the creator's industry");
assert(!r.block.includes("researched for this creator's industry"),
  "the niche claim must NOT appear over platform-wide rows — that was the original overclaim");

// A different creator's segment row must never leak across segments.
LEGACY = [{ ...segmentRow, segment: "fitness" }];
r = await buildTrendContext({ ...BASE, profile: {} });
assert(!r.block.includes("twilight walkthroughs"),
  "a row belonging to another segment must not be served to this one");

// ── 3c. The TikTok fallback reaches the legacy path ────────────────────────
// [TRENDS-SEGMENT] The observed query has always included FALLBACK_PLATFORM;
// the legacy query never did. So a creator on a platform with no segment rows
// of its own — YouTube, Facebook, X, Pinterest — got platform-wide research
// and nothing else, on the path that runs while the observed pipeline is dark.

OBSERVED = [];
const ytGlobal = {
  platform: "YouTube", segment: null, fetched_at: new Date().toISOString(), summary: "",
  items: [{ trend: "Shorts creators leaning on cold opens", category: "format", source_url: "https://example.com/y", reason: "" }],
};
const ttSegment = {
  platform: "TikTok", segment: "real_estate", fetched_at: new Date().toISOString(), summary: "",
  items: [{ trend: "Agents posting sub-60s twilight walkthroughs", category: "format", source_url: "https://example.com/s", reason: "" }],
};

LEGACY = [ytGlobal, ttSegment];
r = await buildTrendContext({ platforms: ["YouTube"], niche: "Real Estate", profile: {} });
assert(r.block.includes("twilight walkthroughs"),
  "a YouTube creator should receive niche-researched TikTok items via the fallback");
assert(r.block.includes("cold opens"),
  "their own platform's items must still be served, not replaced by the fallback");
assert(r.block.includes("from TikTok research, not this creator's platform"),
  "an off-platform item must be framed as such, or it reads as a YouTube trend");
assert(!r.block.includes("peaking on TikTok"),
  "legacy items carry no lifecycle signal — the observed renderer's 'peaking' wording must not be borrowed");

// Own platform leads. On a thin week the fallback must not open the block.
const ytFirst = r.block.indexOf("cold opens");
const ttFirst = r.block.indexOf("twilight walkthroughs");
assert(ytFirst !== -1 && ttFirst !== -1 && ytFirst < ttFirst,
  "the creator's own platform should lead; the fallback fills after it");

// Mixed batches must not let the general item borrow the specific one's
// credibility.
assert(r.block.includes("This batch is MIXED"),
  "a batch mixing niche and platform-wide items must say so");
assert(r.block.includes("(platform-wide, not industry-specific.)"),
  "the platform-wide item must be individually marked inside a mixed batch");

// The negative that keeps check-strategist's rule intact: a GLOBAL TikTok row
// must NOT be borrowed. Platform-wide culture served to a YouTube creator is
// wrong about the industry AND the platform — two layers of imprecision, which
// is exactly what that assertion was written to prevent. Only the segment row
// earns the crossing.
LEGACY = [ytGlobal, { ...ttSegment, segment: null }];
r = await buildTrendContext({ platforms: ["YouTube"], niche: "Real Estate", profile: {} });
assert(!r.block.includes("twilight walkthroughs"),
  "a GLOBAL TikTok row must not be borrowed across platforms — only niche-researched rows earn that");
assert(r.block.includes("cold opens"),
  "declining the borrow must not cost the creator their own platform's items");

// A TikTok creator has no off-platform item, so no framing should appear.
LEGACY = [ttSegment];
r = await buildTrendContext({ platforms: ["TikTok"], niche: "Real Estate", profile: {} });
assert(!r.block.includes("from TikTok research, not this creator's platform"),
  "no cross-platform framing when TikTok IS the creator's platform");
assert(r.block.includes("researched for this creator's industry"),
  "an all-segment batch should carry the unqualified niche claim");

// ── 4. Goal reaches the block, and only when set ───────────────────────────

OBSERVED = [trendRow("Kitchen reveal transition")];
LEGACY = [];

r = await buildTrendContext({ ...BASE, profile: {}, goal: "book listing appointments" });
assert(r.block.includes("TREND SELECTION — THIS CREATOR'S GOAL"),
  "goal block should be present when a goal is supplied");
assert(r.block.includes("book listing appointments"),
  "the stated goal text should appear in the block");

r = await buildTrendContext({ ...BASE, profile: {} });
assert(!r.block.includes("TREND SELECTION — THIS CREATOR'S GOAL"),
  "no goal supplied → no goal block, rather than an empty directive to fill in");

r = await buildTrendContext({ ...BASE, profile: {}, goal: "grow followers", goalSecondary: "grow followers" });
assert((r.block.match(/grow followers/g) || []).length === 1,
  "a secondary goal identical to the primary should not be printed twice");

// ── 5. Topic overlap reorders without excluding ────────────────────────────

OBSERVED = [
  trendRow("Generic transition sound", { niche_scores: { real_estate: 0.8 } }),
  trendRow("Staging walkthrough audio", { niche_scores: { real_estate: 0.8 } }),
];

r = await buildTrendContext({
  ...BASE,
  profile: { pillars: "staging tips, pricing strategy" },
});
assert(r.snapshot.items.length === 2,
  "the topic bonus is a ranking nudge and must never drop an item");
assert(r.snapshot.items[0].display_name === "Staging walkthrough audio",
  "a trend overlapping a stated content pillar should rank ahead of one that doesn't");

// ── 6. Per-platform trend framing ──────────────────────────────────────────
// [PLATFORM-FRAME] X returned zero items for seven consecutive weeks, with
// stored summaries naming the cause in the model's own words: "Quiet week for
// emerging MICRO-TRENDS on X". The prompt described TikTok and was applied to
// every platform. These assertions pin the override to X and — more
// importantly — prove the other six are untouched, because the risk of a
// per-platform frame is that it quietly becomes a per-platform rewrite.

const { buildTrendsPrompt } = await import("../api/_lib/trends-research.js");

const xPrompt = buildTrendsPrompt("X", {});
assert(xPrompt.includes("Macro and news topics ARE in scope on X"),
  "X should get the macro-permitting rule — excluding macro removes X's entire surface");
assert(!xPrompt.includes("STRICT exclusion of mainstream/macro items"),
  "the generic macro exclusion must be REPLACED for X, not merely appended to");
assert(!xPrompt.includes("Trending audio"),
  "X has no audio — asking for it spends a slot on nothing");
assert(!xPrompt.includes("business.x.com"),
  "X's advertiser blogs carry product news, never creator trends");
assert(xPrompt.includes("do not look for TikTok-style micro-trends here"),
  "X should be told the absence of micro-trends is not a useful answer");
// Permissive on subject, unchanged on rigour — the whole risk of relaxing #5
// is reopening the generic-slop door that constraint #4 guards.
assert(xPrompt.includes("STRICT exclusion of evergreen advice"),
  "relaxing the macro rule must NOT relax the evergreen-advice ban");
assert(xPrompt.includes("MUST cite an exact source URL"),
  "relaxing the macro rule must NOT relax the citation requirement");
assert(/does NOT relax specificity/i.test(xPrompt),
  "the macro allowance must say in the prompt that specificity still applies");

for (const p of ["TikTok", "Instagram", "LinkedIn", "YouTube", "Facebook", "Pinterest"]) {
  const prompt = buildTrendsPrompt(p, {});
  assert(prompt.includes("STRICT exclusion of mainstream/macro items"),
    `${p} must keep the original macro rule — only X has evidence for the override`);
  assert(prompt.includes("Trending audio"),
    `${p} must keep the original surface list unchanged`);
  assert(!prompt.includes("Macro and news topics ARE in scope"),
    `${p} must not pick up X's framing`);
}

// The niche layer has to survive the override, or X segment rows go back to
// being platform-wide research under a segment label.
const xNiche = buildTrendsPrompt("X", { niche: "Real Estate" });
assert(xNiche.includes("Real Estate"),
  "the X frame must still carry the niche focus — otherwise segment rows are global rows with a label");

// ── done ───────────────────────────────────────────────────────────────────

if (failures) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("OK: trend selection honors segment, stated boundaries, goals, and pillars — and filters nothing without cause.");
