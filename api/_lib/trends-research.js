// Per-platform trends research for the weekly cron. Asks Perplexity Sonar
// to surface what's actually working THIS WEEK on a given platform —
// trending topics, hashtags, audio (where applicable), emerging formats,
// hooks that are getting outsized engagement.
//
// [COST 4] Migrated from Claude + web_search to Perplexity Sonar. The
// stored row shape is identical (`{ platform, summary, items, sources,
// fetched_at }`), so loadLatestTrends + the prompt builders see no change.
// Perplexity returns citations as a top-level array on the response, which
// we map directly into the `sources` field.
//
// Difference from playbook-research:
//   - Trends auto-publish (no admin approval), since they're transparently
//     dated and sourced and refreshed weekly. The user can see "as of
//     <date>" and form their own judgment.
//   - Lower latency window: only items from the last 14 days qualify.
//   - Returns up to 7 concise items per platform.

import { callPerplexity, tryParseJSON } from "./perplexity.js";

const TRUSTED_SOURCES_GENERAL = [
  "sproutsocial.com/insights",
  "blog.hootsuite.com",
  "buffer.com/resources",
  "socialmediaexaminer.com",
  "searchenginejournal.com",
];

const TRUSTED_SOURCES_PLATFORM = {
  TikTok:    ["newsroom.tiktok.com", "creators.tiktok.com"],
  Instagram: ["creators.instagram.com", "about.instagram.com"],
  LinkedIn:  ["business.linkedin.com", "linkedin.com/business/marketing"],
  YouTube:   ["blog.youtube", "creatoracademy.youtube.com"],
  Facebook:  ["about.fb.com", "business.facebook.com"],
  X:         ["business.x.com", "blog.x.com"],
  Pinterest: ["business.pinterest.com", "newsroom.pinterest.com"],
};

function buildTrendsPrompt(platform) {
  const platformSources = TRUSTED_SOURCES_PLATFORM[platform] || [];
  const allSources = [...platformSources, ...TRUSTED_SOURCES_GENERAL];
  return [
    "Research what's working right now (this week) on " + platform + " for content creators.",
    "",
    "Surface up to 7 of the following:",
    "  - Trending topics or themes",
    "  - Trending hashtags",
    "  - Trending audio (where applicable to the platform)",
    "  - Emerging or surging content formats",
    "  - Specific hook or opening angles that are getting outsized engagement",
    "",
    "Constraints:",
    "1. Prefer information from these trusted sources when available:",
    allSources.map(s => "   - " + s).join("\n"),
    "2. Each item MUST cite an exact source URL — use the full https:// URL, not a citation marker like [1].",
    "3. Skip anything older than 14 days — we want THIS WEEK's signal.",
    "4. Skip evergreen advice (e.g., 'use trending audio' — that's not a trend, it's a rule). We want specific, named, currently-hot items.",
    "5. If the platform has had a quiet week with no notable signal, return an empty items list rather than padding.",
    "",
    "Return ONLY valid JSON (no markdown, no preamble):",
    "{",
    '  "summary": "<one sentence overview of the week>",',
    '  "items": [',
    "    {",
    '      "trend": "<concise description of the trend, 1-2 sentences>",',
    '      "category": "topic" | "audio" | "format" | "hook" | "hashtag",',
    '      "source_url": "<exact URL>",',
    '      "reason": "<one sentence on why it\'s working right now>"',
    "    }",
    "  ],",
    '  "sources": ["<url>", "..."]',
    "}",
    "",
    "If no notable shifts: { \"summary\": \"Quiet week — no notable trends from trusted sources.\", \"items\": [], \"sources\": [] }",
  ].join("\n");
}

// Returns { summary, items, sources } or null on failure.
export async function researchTrends(platform) {
  const prompt = buildTrendsPrompt(platform);
  const result = await callPerplexity({ prompt, model: "sonar", maxTokens: 3500 });
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
