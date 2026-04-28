// Per-platform trends research for the weekly cron. Asks Claude to
// surface what's actually working THIS WEEK on a given platform —
// trending topics, hashtags, audio (where applicable), emerging formats,
// hooks that are getting outsized engagement.
//
// Difference from playbook-research:
//   - Trends auto-publish (no admin approval), since they're transparently
//     dated and sourced and refreshed weekly. The user can see "as of
//     <date>" and form their own judgment.
//   - Lower latency window: only items from the last 14 days qualify.
//   - Returns up to 7 concise items per platform.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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
    "Use web_search to surface up to 7 of the following:",
    "  - Trending topics or themes",
    "  - Trending hashtags",
    "  - Trending audio (where applicable to the platform)",
    "  - Emerging or surging content formats",
    "  - Specific hook or opening angles that are getting outsized engagement",
    "",
    "Constraints:",
    "1. Only use information from these trusted sources:",
    allSources.map(s => "   - " + s).join("\n"),
    "2. Each item MUST cite an exact source URL.",
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

function extractText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter(b => b && b.type === "text")
    .map(b => b.text)
    .join("");
}

function tryParseJSON(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (e) {}
  }
  try { return JSON.parse(text.trim()); } catch (e) {}
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

// Returns { summary, items, sources } or null on failure.
export async function researchTrends(platform) {
  if (!ANTHROPIC_API_KEY) return null;
  const prompt = buildTrendsPrompt(platform);
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
        max_tokens: 3500,
        tools: [
          { type: "web_search_20250305", name: "web_search", max_uses: 5 },
        ],
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (e) {
    console.error("[trends-research] fetch threw for", platform, e.message);
    return null;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("[trends-research] Anthropic error", platform, res.status, errText);
    return null;
  }
  let body;
  try { body = await res.json(); } catch (e) { return null; }
  const parsed = tryParseJSON(extractText(body));
  if (!parsed) return null;
  // Light shape validation so a malformed response doesn't break callers.
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    items:   Array.isArray(parsed.items)   ? parsed.items   : [],
    sources: Array.isArray(parsed.sources) ? parsed.sources : [],
  };
}
