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

// ── done ───────────────────────────────────────────────────────────────────

if (failures) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("OK: trend selection honors stated boundaries, goals, and pillars — and filters nothing without cause.");
