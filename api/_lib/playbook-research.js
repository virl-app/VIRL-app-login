// Per-platform playbook research call.
//
// [COST 4] Migrated from Anthropic + web_search to Perplexity Sonar.
// Perplexity executes its own web search inside the model call and returns
// a `citations` array on the response; we map those URLs to the existing
// `sources` field, leaving the return shape identical for downstream
// playbook_drafts inserts + admin diff review.
//
// Conservative by design: the prompt instructs the model to only propose
// changes that are sourced to the trusted-source allowlist below. The
// admin reviews every diff before anything reaches the live playbook.

import { callPerplexity, tryParseJSON } from "./perplexity.js";

// Trusted-source allowlist baked into the prompt. Per-platform officials +
// reputable analyst blogs. Extend this list when you onboard new sources.
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

// Field metadata mirrors the playbook schema. Used to tell the model what
// shape each field expects so it doesn't return mismatched types.
const FIELD_HINTS = {
  cadence:         "string — e.g. '1-3 posts/day'",
  peak_times:      "string — e.g. '9-11am EST and 6-9pm EST'",
  duration:        "string — duration / length guidance",
  hook_window:     "string — what the hook needs to do",
  hashtag_count:   "string — e.g. '3-5'",
  hashtag_mix:     "string — e.g. '1 broad + 1 niche + 1 trending'",
  caption_limit:   "integer — character limit before truncation, or null",
  top_signals:     "array of strings — algorithmic signals the platform rewards",
  format_priority: "array of strings — formats in descending order of algorithmic preference",
  notes:           "string — free-text guidance",
};

function buildResearchPrompt(platform, currentEntry) {
  const platformSources = TRUSTED_SOURCES_PLATFORM[platform] || [];
  const allSources = [...platformSources, ...TRUSTED_SOURCES_GENERAL];
  const fieldHintLines = Object.keys(FIELD_HINTS)
    .map(k => "  - " + k + ": " + FIELD_HINTS[k])
    .join("\n");

  return [
    "You are auditing the VIRL platform playbook for " + platform + " to make sure it reflects current best practices.",
    "",
    "CURRENT ENTRY:",
    JSON.stringify(currentEntry, null, 2),
    "",
    "YOUR TASK:",
    "Find updates from these trusted sources within the last 6 months:",
    allSources.map(s => "  - " + s).join("\n"),
    "",
    "Only propose changes that meet ALL of these criteria:",
    "1. A trusted source from the list above explicitly contradicts or updates what's currently in our playbook.",
    "2. You can cite the exact source URL — use the full https:// URL, not a citation marker like [1].",
    "3. The change reflects current 2026 reality — not 2023 evergreen advice.",
    "",
    "Field types to respect when proposing values:",
    fieldHintLines,
    "",
    "Return ONLY valid JSON (no markdown, no preamble):",
    "{",
    '  "no_changes_needed": <bool>,',
    '  "summary": "<one sentence overview>",',
    '  "proposed_changes": {',
    '    "<field_name>": {',
    '      "new_value": <value matching the field type above>,',
    '      "source_url": "<exact URL>",',
    '      "reason": "<one sentence on what changed and why we should adopt it>"',
    "    }",
    "  },",
    '  "sources": ["<url1>", "<url2>", "..."]',
    "}",
    "",
    "If nothing meaningful has changed, return:",
    '{ "no_changes_needed": true, "summary": "No updates from trusted sources in the last 6 months.", "proposed_changes": {}, "sources": [] }',
    "",
    "Be conservative — when in doubt, leave the field as-is. The user reviews every change before it goes live.",
  ].join("\n");
}

// Main entry. Returns the parsed research result for one platform, or null
// on any failure (caller logs and continues to the next platform).
export async function researchPlatform(platform, currentEntry) {
  const prompt = buildResearchPrompt(platform, currentEntry);
  const result = await callPerplexity({ prompt, model: "sonar", maxTokens: 4000 });
  if (!result) return null;
  const parsed = tryParseJSON(result.text);
  if (!parsed) {
    console.error("[playbook-research] could not parse JSON for", platform);
    return null;
  }
  // [COST 4] Prefer Perplexity's top-level citations — they come back as
  // raw URLs we can trust. The model's in-JSON `sources` is best-effort
  // and only used when Perplexity returned no citations (offline mode,
  // tier downgrade, etc.).
  if (result.citations.length) {
    parsed.sources = result.citations;
  } else if (!Array.isArray(parsed.sources)) {
    parsed.sources = [];
  }
  return parsed;
}
