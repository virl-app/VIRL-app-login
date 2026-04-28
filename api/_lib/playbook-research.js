// Per-platform playbook research call. Uses Anthropic's server-side
// web_search tool (Anthropic executes the searches; we only receive the
// final structured response) so the cron can stay a single round-trip.
//
// Conservative by design: the prompt instructs the model to only propose
// changes that are sourced to the trusted-source allowlist below. The
// admin reviews every diff before anything reaches the live playbook.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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
    "Use web_search to find updates from these trusted sources within the last 6 months:",
    allSources.map(s => "  - " + s).join("\n"),
    "",
    "Only propose changes that meet ALL of these criteria:",
    "1. A trusted source from the list above explicitly contradicts or updates what's currently in our playbook.",
    "2. You can cite the exact source URL.",
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

// Extract text from Claude's response. Web search responses include
// `web_search_tool_result` blocks alongside the final `text` block; we
// concatenate just the text content.
function extractText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter(b => b && b.type === "text")
    .map(b => b.text)
    .join("");
}

function tryParseJSON(text) {
  if (!text) return null;
  // Strip fenced code blocks if present
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (e) { /* fall through */ }
  }
  // Otherwise try the whole text
  try { return JSON.parse(text.trim()); } catch (e) {}
  // Last resort: extract the outer object
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

// Main entry. Returns the parsed research result for one platform, or null
// on any failure (caller logs and continues to the next platform).
export async function researchPlatform(platform, currentEntry) {
  if (!ANTHROPIC_API_KEY) return null;
  const prompt = buildResearchPrompt(platform, currentEntry);

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type":      "application/json",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 4000,
        tools: [
          { type: "web_search_20250305", name: "web_search", max_uses: 5 },
        ],
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (e) {
    console.error("[playbook-research] fetch threw for", platform, e.message);
    return null;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("[playbook-research] Anthropic error for", platform, res.status, errText);
    return null;
  }

  let body;
  try { body = await res.json(); } catch (e) { return null; }

  const text = extractText(body);
  const parsed = tryParseJSON(text);
  if (!parsed) {
    console.error("[playbook-research] could not parse JSON for", platform);
    return null;
  }
  return parsed;
}
