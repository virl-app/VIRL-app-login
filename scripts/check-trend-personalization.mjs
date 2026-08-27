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

// ── 3b-ii. An EMPTY segment row must not shadow a populated global row ─────
// [TRENDS-SEGMENT-EMPTY] Observed in production the first week per-segment
// research shipped: 15 of 20 segment rows returned zero items, 14 of them over
// a populated global row, and because the
// tier preference was unconditional they displaced populated global rows. All
// nine TikTok segments went dark while a 12-item global TikTok row sat unused.
// The pair below is the point — one assertion that the empty row stops
// shadowing, one that the tier preference it was built on is still intact.
const emptySegmentRow = { ...segmentRow, items: [] };

LEGACY = [globalRow, emptySegmentRow];
r = await buildTrendContext({ ...BASE, profile: {} });
assert(r.block.includes("Microwave Challenge"),
  "an empty segment row must fall through to the global row, not blank the platform");
assert(r.block.includes("PLATFORM-WIDE research"),
  "falling through to global must also downgrade the provenance claim to match");

// Order-independence again: the empty row arriving first must not win by being
// seen first, which is how a rank check regresses into a first-writer-wins one.
LEGACY = [emptySegmentRow, globalRow];
r = await buildTrendContext({ ...BASE, profile: {} });
assert(r.block.includes("Microwave Challenge"),
  "row order must not decide it — an empty segment row loses whenever it is seen");

// The other half of the pair: nothing was traded away to fix it. A POPULATED
// segment row must still beat a populated global row, older or not.
LEGACY = [globalRow, segmentRow];
r = await buildTrendContext({ ...BASE, profile: {} });
assert(r.block.includes("twilight walkthroughs") && !r.block.includes("Microwave Challenge"),
  "a populated segment row must still outrank a global one — the tier preference is not what broke");

// A row whose items all lack a usable `trend` name is empty in every sense the
// renderer cares about, and must rank as empty rather than as populated-but-
// silent — otherwise it wins its platform and then renders nothing.
LEGACY = [globalRow, { ...segmentRow, items: [{ trend: "   ", category: "format" }] }];
r = await buildTrendContext({ ...BASE, profile: {} });
assert(r.block.includes("Microwave Challenge"),
  "a segment row of nameless items must rank as empty, not shadow the global row");

// Both tiers empty: the block stays empty and nothing is invented from it.
LEGACY = [{ ...globalRow, items: [] }, emptySegmentRow];
r = await buildTrendContext({ ...BASE, profile: {} });
assert(!r.block.includes("twilight walkthroughs") && !r.block.includes("Microwave Challenge"),
  "two empty rows must produce no items rather than resurrecting either one");

// The cross-platform rule must survive the rank change: an empty TikTok SEGMENT
// row must not let a global TikTok row take the borrowed slot in its place.
// (Section 3c's fixtures are declared below this point, so these are local.)
const ytOwn = {
  platform: "YouTube", segment: null, fetched_at: new Date().toISOString(), summary: "",
  items: [{ trend: "Shorts creators leaning on cold opens", category: "format", source_url: "https://example.com/y", reason: "" }],
};
LEGACY = [ytOwn, { ...segmentRow, items: [] }, globalRow];
r = await buildTrendContext({ platforms: ["YouTube"], niche: "Real Estate", profile: {} });
assert(!r.block.includes("Microwave Challenge"),
  "an empty segment row must not open the borrowed slot to a GLOBAL row of another platform");
assert(r.block.includes("cold opens"),
  "the creator's own platform must still serve while the borrow declines");

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

// The two platforms that WORK must not be touched. TikTok and Instagram Reels
// are the medium the generic prompt describes, they are the only two with zero
// quiet weeks, and they are the last thing that should change. This is the
// assertion that stops a per-platform frame becoming a per-platform rewrite.
for (const p of ["TikTok", "Instagram"]) {
  const prompt = buildTrendsPrompt(p, {});
  assert(prompt.includes("STRICT exclusion of mainstream/macro items"),
    `${p} must keep the original macro rule — it is demonstrably working`);
  assert(prompt.includes("Trending audio"),
    `${p} must keep the original surface list, unchanged`);
  assert(prompt.includes("prioritize micro-trends"),
    `${p} must keep the original framing — short-form video is what it describes`);
  assert(!prompt.includes("ARE in scope"),
    `${p} must not pick up another platform's framing`);
}

// Every framed platform: new surface list, same rigour. Relaxing what counts
// as a trend must never relax what counts as evidence.
for (const p of ["X", "LinkedIn", "YouTube", "Pinterest", "Facebook"]) {
  const prompt = buildTrendsPrompt(p, {});
  assert(!prompt.includes("Trending audio"),
    `${p} should not be asked for audio — that is a short-form-video surface`);
  assert(prompt.includes("do not look for TikTok-style micro-trends here"),
    `${p} should be told the absence of micro-trends is not a useful answer`);
  assert(prompt.includes("STRICT exclusion of evergreen advice"),
    `${p} must keep the evergreen ban — reframing is not permission for slop`);
  assert(prompt.includes("MUST cite an exact source URL"),
    `${p} must keep the citation requirement`);
  assert(buildTrendsPrompt(p, { niche: "Real Estate" }).includes("Real Estate"),
    `${p} must still carry the niche focus, or segment rows are global rows with a label`);
}

// [YT-MACRO] This assertion previously pinned the opposite: YouTube was framed
// but deliberately KEPT the macro exclusion, on the reasoning that "its demand
// is already niche-level, so only the surface list needed changing."
//
// That reasoning is correct about YouTube DEMAND and wrong about what is
// findable weekly, which is the thing the prompt actually depends on. Search
// demand on YouTube genuinely is niche-level — but almost nobody publishes
// this week's niche-level YouTube demand, so the model had a widened surface
// list and a constraint still forbidding the only signal it could reach.
//
// Measured over the three runs after the 2026-08-10 frames, mean items/run:
//
//   X 0.0 -> 6.5   Pinterest 1.1 -> 6.0   Facebook 1.7 -> 6.0   LinkedIn 4.0 -> 6.0
//   YouTube 1.7 -> 0.3    <- only framed platform without a macroRule,
//                            only platform that went backwards
//
// And it said so, three summaries running: "the only clearly relevant
// primary-source signal surfaced was YouTube's upcoming shift to engaged-view
// counting" (1 item), "surfaced policy and creator-infrastructure updates"
// (0 items), "without drifting into generic platform updates" (0 items).
//
// A channel is a library, not a feed, so how the machine counts, ranks and
// pays is what changes the brief. That is now in scope, and the assertion
// pins the new decision with the evidence so it is not quietly flipped back.
//
// The old comment's general principle — a frame need not relax every rule —
// remains true; it simply has no example left, since all five framed
// platforms now carry a macroRule. Do not re-add a hollow one to preserve it.
const ytPrompt = buildTrendsPrompt("YouTube", {});
assert(!ytPrompt.includes("STRICT exclusion of mainstream/macro items"),
  "YouTube fell back to the generic macro exclusion — that pairing (widened surface list, unchanged constraint) took it from 1.7 items a run to 0.3 while it kept finding platform changes and discarding them");
assert(/algorithm and monetization changes ARE in scope/.test(ytPrompt),
  "YouTube lost its platform-change rule — algorithm, counting and monetization shifts are the signal this platform actually has each week");
assert(ytPrompt.includes("older than 30 days"),
  "YouTube is back on the 14-day window — a change announced three weeks out is more actionable than one already live, and the lead time is the value");
assert(ytPrompt.includes("Title and thumbnail patterns"),
  "YouTube should be asked about packaging, which is where its trends actually live");

// The three that DO relax the macro rule must each say specificity still holds,
// in the prompt itself and not merely in a comment here.
for (const p of ["X", "LinkedIn", "Pinterest", "Facebook"]) {
  const prompt = buildTrendsPrompt(p, {});
  assert(!prompt.includes("STRICT exclusion of mainstream/macro items"),
    `${p}'s macro rule must be REPLACED, not appended to — both present is contradictory`);
  assert(/does NOT relax specificity/i.test(prompt),
    `${p} must state in the prompt that permitting macro subjects does not permit vagueness`);
}

// The niche layer has to survive the override, or X segment rows go back to
// being platform-wide research under a segment label.
const xNiche = buildTrendsPrompt("X", { niche: "Real Estate" });
assert(xNiche.includes("Real Estate"),
  "the X frame must still carry the niche focus — otherwise segment rows are global rows with a label");

// ── 6b. The niche ask is tiered, and the global ask is untouched ───────────
// [NICHE-TIERS] The first week the per-segment cron ran, 15 of 20 segment rows
// came back with zero items — all nine TikTok segments, five of nine Instagram
// — while the SAME prompt minus the niche line returned 12 items per platform
// the same week. The niche line demanded trends invented BY the niche and
// called anything else "not interesting", so the model took constraint #6's
// empty-list option rather than report the real signal it had found.

for (const p of ["TikTok", "Instagram"]) {
  const nichePrompt = buildTrendsPrompt(p, { niche: "Real Estate" });

  // The three tiers, and the instruction that makes them more than decoration.
  assert(/TIER 1/.test(nichePrompt) && /TIER 2/.test(nichePrompt) && /TIER 3/.test(nichePrompt),
    `${p} niche research must offer all three tiers of niche signal`);
  assert(/ALWAYS prefer a lower tier over returning nothing/i.test(nichePrompt),
    `${p} must be told to drop a tier rather than return nothing — without this the tiers are advisory and the row still comes back empty`);
  assert(/audience/i.test(nichePrompt),
    `${p} niche research must count audience-side signal, not only creator-side`);

  // The old absolutism is what emptied the rows. It must be gone, not softened
  // and left in alongside the tiers, which would be contradictory.
  assert(!/is not interesting/i.test(nichePrompt),
    `${p} must not tell the model platform-wide signal is uninteresting — that is what produced 14 empty rows`);

  // Tier 3 is the load-bearing compromise: it admits platform-wide trends ONLY
  // with a named niche application. Without that the segment row degrades into
  // the global row it is supposed to improve on.
  assert(/name the specific Real Estate application in the item itself/i.test(nichePrompt),
    `${p} tier 3 must require the niche application be named, or segment rows become global rows with a label`);
  assert(/does not count|does NOT count/.test(nichePrompt),
    `${p} must still refuse an unapplied platform-wide trend — the global row already carries those`);

  // Reframing what counts as a trend must not relax what counts as evidence.
  // Same rule the platform frames are held to.
  assert(nichePrompt.includes("MUST cite an exact source URL"),
    `${p} niche research must keep the citation requirement`);
  assert(nichePrompt.includes("STRICT exclusion of evergreen advice"),
    `${p} niche research must keep the evergreen ban — widening the ask is not permission for slop`);
  assert(/rather than padding/i.test(nichePrompt),
    `${p} must keep the anti-padding rule — an honest zero is still better than filler`);

  // The empty-list exit stays available but its bar is stated, since "no tier-1
  // signal" was being read as "quiet week".
  assert(/is NOT a quiet week/i.test(nichePrompt),
    `${p} must say that an absence of niche-native signal is not by itself a quiet week`);

  // The prompt must not also hand back a pre-written empty answer. All 20
  // segment rows opened with "Quiet week" — the exact phrase the stock template
  // supplies — so raising the bar in constraint #6 achieves nothing while the
  // last line remains a fill-in-the-blank way to give up.
  assert(!nichePrompt.includes('"summary": "Quiet week'),
    `${p} niche research must not pre-write a "Quiet week" summary — the model copies it verbatim`);
  assert(/Only if all three tiers genuinely came up empty/.test(nichePrompt),
    `${p} must still offer an empty shape — an honest zero has to stay expressible`);
  assert(/do not just call it a quiet week/i.test(nichePrompt),
    `${p}'s empty case must ask what was searched, since trends.summary is the field that diagnoses these failures`);
}

// The global path is the one that WORKS — 12 items per platform in the same
// week the segment rows were empty. It must not pick up any of the above. This
// is the same guard that stops a per-platform frame becoming a rewrite.
for (const p of ["TikTok", "Instagram", "X", "LinkedIn", "YouTube", "Pinterest", "Facebook"]) {
  const globalPrompt = buildTrendsPrompt(p, {});
  assert(!/TIER 1/.test(globalPrompt),
    `${p}'s global prompt must not carry the niche tiers — it has no niche to tier by`);
  assert(!/is NOT a quiet week/i.test(globalPrompt),
    `${p}'s global prompt must keep the original constraint #6 — it is not the path that was failing`);
  assert(globalPrompt.includes("If the platform has had a quiet week with no notable signal, return an empty items list"),
    `${p}'s global prompt must keep constraint #6 verbatim`);
  assert(globalPrompt.includes('"summary": "Quiet week'),
    `${p}'s global prompt keeps the stock empty template — it is producing full batches and is not what we are fixing`);
}

// ── done ───────────────────────────────────────────────────────────────────

if (failures) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("OK: trend selection honors segment, stated boundaries, goals, and pillars — and filters nothing without cause.");
