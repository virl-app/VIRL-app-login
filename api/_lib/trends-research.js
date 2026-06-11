// Per-platform trends research for the weekly cron AND the inline path
// per generation. Asks Perplexity Sonar to surface what's actually working
// THIS WEEK on a given platform — trending topics, hashtags, audio (where
// applicable), emerging formats, hooks that are getting outsized engagement.
//
// [COST 4] Migrated from Claude + web_search to Perplexity Sonar. The
// stored row shape is identical (`{ platform, summary, items, sources,
// fetched_at }`), so loadLatestTrends + the prompt builders see no change.
// Perplexity returns citations as a top-level array on the response, which
// we map directly into the `sources` field.
//
// [TRENDS-VARIETY] researchTrends now accepts a second `opts` argument:
//   - niche:         optional creator niche (e.g. "Real Estate", "Fitness")
//                    woven into the prompt so a fitness creator gets fitness-
//                    specific TikTok trends, not generic platform recap.
//   - excludeTrends: optional array of trend description strings to avoid —
//                    typically the user's recent surfaced trends so week-
//                    over-week generation feels fresh.
// Cron callers pass an empty opts (global, niche-agnostic), the inline
// per-generation path passes both. Backward-compatible: omitting opts
// produces the same prompt the cron has always used.
//
// Difference from playbook-research:
//   - Trends auto-publish (no admin approval), since they're transparently
//     dated and sourced and refreshed weekly. The user can see "as of
//     <date>" and form their own judgment.
//   - Lower latency window: only items from the last 14 days qualify.
//   - Returns up to 12 concise items per platform (was 7).

import { callPerplexity, tryParseJSON } from "./perplexity.js";

// [TRENDS-VARIETY] Trusted-source preference removed from a HARD constraint
// to a SOFT bias. The old allowlist pushed Perplexity toward marketing
// recap publications that report the same top-of-mind trends every week,
// which is the main reason VIRL users kept seeing identical trends. Now
// these sources are surfaced as "you may use" examples, not "prefer."
const SOURCE_HINTS_GENERAL = [
  "sproutsocial.com/insights",
  "blog.hootsuite.com",
  "buffer.com/resources",
  "socialmediaexaminer.com",
];

const SOURCE_HINTS_PLATFORM = {
  TikTok:    ["newsroom.tiktok.com", "creators.tiktok.com"],
  Instagram: ["creators.instagram.com", "about.instagram.com"],
  LinkedIn:  ["business.linkedin.com"],
  YouTube:   ["blog.youtube", "creatoracademy.youtube.com"],
  Facebook:  ["about.fb.com"],
  X:         ["business.x.com", "blog.x.com"],
  Pinterest: ["business.pinterest.com"],
};

function buildTrendsPrompt(platform, opts) {
  const niche         = (opts && typeof opts.niche === "string") ? opts.niche.trim() : "";
  const excludeTrends = (opts && Array.isArray(opts.excludeTrends))
    ? opts.excludeTrends.filter(t => typeof t === "string" && t.trim()).slice(0, 15)
    : [];
  const platformHints = SOURCE_HINTS_PLATFORM[platform] || [];
  const hintList      = [...platformHints, ...SOURCE_HINTS_GENERAL];

  // Niche header — when present, sharpens the whole search toward that
  // creator's vertical. When absent, prompt reads as a generic platform
  // trends scan (the cron's behavior).
  const nicheLine = niche
    ? "Niche focus: " + niche + " creators specifically. We want trends moving in THIS niche, not generic platform-wide signal. A trend that's hot on TikTok overall is not interesting; a trend that's hot among " + niche + " creators IS."
    : "";

  // Exclusion block — only added when the caller has a list of trends the
  // user has already seen recently. Phrased gently so Perplexity doesn't
  // refuse to return anything when overlap is unavoidable.
  const excludeBlock = excludeTrends.length
    ? "Recently surfaced to this creator (try to find NEW signal that doesn't duplicate these — if a new wave of one of these is clearly emerging, that's fine, but prefer fresh):\n"
        + excludeTrends.map(t => "  - " + t).join("\n")
    : "";

  return [
    "Research what's working right now (this week) on " + platform + " for content creators.",
    "",
    nicheLine,
    "",
    "Surface up to 12 of the following — prioritize micro-trends and emerging signals over established mainstream items:",
    "  - Trending topics or themes",
    "  - Trending hashtags (specific ones, not '#fyp')",
    "  - Trending audio (where applicable to the platform)",
    "  - Emerging or surging content formats",
    "  - Specific hook or opening angles that are getting outsized engagement",
    "  - Sub-niche conversations gaining traction in the past 7-14 days",
    "",
    "What we want: SPECIFIC, NAMED, recently-emerging items. A trend used by 500 creators last week and 5000 this week is FAR more valuable than one with 1M users that's been hot for a month.",
    "",
    excludeBlock,
    "",
    "Constraints:",
    "1. Sources: anything publicly visible — actual posts on the platform, Reddit/Discord discussions, niche newsletters, individual creator commentary. These industry pubs are OK signal too but should not dominate: " + hintList.join(", "),
    "2. Each item MUST cite an exact source URL — use the full https:// URL, not a citation marker like [1]. If the source is a TikTok / Reel / post, link to the post itself.",
    "3. Skip anything older than 14 days — we want THIS WEEK's signal.",
    "4. STRICT exclusion of evergreen advice. 'Use trending audio,' 'post consistently,' 'engage with your audience' — these are rules, not trends. ONLY return specific named items.",
    "5. STRICT exclusion of mainstream/macro items unless they have a niche-specific angle. 'AI tools are trending' is not useful; 'Five specific AI tools getting traction in [niche] this week' is.",
    "6. If the platform has had a quiet week with no notable signal, return an empty items list rather than padding.",
    "",
    "Return ONLY valid JSON (no markdown, no preamble):",
    "{",
    '  "summary": "<one sentence overview of the week>",',
    '  "items": [',
    "    {",
    '      "trend": "<concise description, 1-2 sentences. Be specific — name the hashtag, the audio, the format, the angle>",',
    '      "category": "topic" | "audio" | "format" | "hook" | "hashtag",',
    '      "source_url": "<exact URL>",',
    '      "reason": "<one sentence on why it\'s working right now>"',
    "    }",
    "  ],",
    '  "sources": ["<url>", "..."]',
    "}",
    "",
    "If no notable shifts: { \"summary\": \"Quiet week — no notable trends from trusted sources.\", \"items\": [], \"sources\": [] }",
  ].filter(line => line !== "").join("\n");
}

// Returns { summary, items, sources } or null on failure.
// opts: { niche?: string, excludeTrends?: string[] } — both optional. The
// cron path calls without opts (global trends). The inline path passes
// niche from params.niche and excludeTrends from the user's recent plan
// history.
export async function researchTrends(platform, opts) {
  const prompt = buildTrendsPrompt(platform, opts);
  // Token budget slightly higher to accommodate 12 items vs the old 7.
  const result = await callPerplexity({ prompt, model: "sonar", maxTokens: 5000 });
  if (!result) return null;
  const parsed = tryParseJSON(result.text);
  if (!parsed) {
    console.error("[trends-research] could not parse JSON for", platform);
    return null;
  }
  // [COST 4] Prefer Perplexity's top-level citations over whatever the
  // model put inside the JSON. Citations come back as raw URLs we can
  // trust; the in-JSON `sources` array is best-effort. Fall back to the
  // parsed array only if Perplexity returned no citations (offline mode,
  // tier downgrade, etc.).
  const sources = result.citations.length
    ? result.citations
    : (Array.isArray(parsed.sources) ? parsed.sources : []);
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    items:   Array.isArray(parsed.items)   ? parsed.items   : [],
    sources,
  };
}
