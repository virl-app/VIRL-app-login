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

// [TRENDS-SOURCES] Where to look — and, by omission, where not to.
//
// This list used to be sproutsocial / hootsuite / buffer / socialmediaexaminer.
// Demoting them from "prefer" to "you may use" (the prior fix) was the right
// direction and not enough: naming four recap publications in the prompt still
// anchors the model to them, and those four recap the same handful of trends
// every week from each other. That is the mechanism behind "every week's
// trends look the same" — the sources are downstream aggregators reporting on
// each other, so the output is a recap of a recap.
//
// The replacement points at PRIMARY venues: places where the conversation is
// actually happening rather than being summarized a week later. Reddit and
// niche forums are where a creator's own audience asks questions in public,
// which is the signal most likely to be usable in a caption. The per-platform
// hints below stay — those are first-party newsrooms, primary by definition.
const SOURCE_HINTS_GENERAL = [
  "reddit.com (subreddits for the niche and for the creators serving it)",
  "the platform itself — actual posts, comment sections, and creator commentary",
  "niche trade press and practitioner newsletters",
  "YouTube and podcast discussion within the niche",
];

// [SEARCH-CONTROLS] The deny-list form of the rule constraint #1b states in
// prose. Prefixed with "-" per Perplexity's exclusion syntax and capped at the
// documented 10 entries, so this is the ten worst offenders rather than the
// whole category — the prose constraint still carries the rest.
//
// The prompt text is deliberately NOT removed now that this exists. Two
// reasons: the wrapper drops these filters and retries on a 4xx (tier gating,
// param drift), so the prose is the fallback that survives that path; and
// "avoid as PRIMARY evidence" is a judgment about how a source is used, which
// no domain filter can express — a deny-list can only remove the domain
// entirely, which would also lose its legitimate corroborating use.
const EXCLUDED_RECAP_DOMAINS = [
  "-sproutsocial.com",
  "-hootsuite.com",
  "-buffer.com",
  "-socialmediaexaminer.com",
  "-later.com",
  "-influencermarketinghub.com",
  "-semrush.com",
  "-hubspot.com",
  "-socialpilot.co",
  "-planoly.com",
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

// [PLATFORM-FRAME] What counts as a "trend" is not the same on every platform,
// and this prompt used to assume it was.
//
// The generic wording — "prioritize micro-trends", constraint #5's strict
// exclusion of macro items, a request for trending audio — describes TikTok
// exactly. It describes X almost not at all, and X produced ZERO items for
// seven consecutive weeks while every other platform produced something. The
// stored summaries name the reason in the model's own words: "Quiet week for
// emerging MICRO-TRENDS on X", "no specific, named MICRO-trends". It was not
// failing and not erroring. It searched, found the discourse that X actually
// runs on, was forbidden by constraint #5 from returning any of it, and
// correctly took constraint #6's empty-list option. Seven times.
//
// On X the macro conversation IS the content opportunity: a creator's job
// there is to have a take on what the room is already arguing about. Excluding
// macro items removes the entire surface.
//
// This started as an X-only override on the grounds that the other platforms
// were producing SOMETHING and only X had evidence. The item counts hid the
// real shape. Reading how many weeks each platform's `summary` reported a
// quiet week, over the same window:
//
//   X          7/7 quiet   avg 0.0 items
//   Facebook   6/7 quiet   avg 1.7
//   Pinterest  6/7 quiet   avg 1.1
//   YouTube    5/7 quiet   avg 1.7
//   LinkedIn   4/6 quiet   avg 4.0
//   Instagram  0/7 quiet   avg 12.0
//   TikTok     healthy
//
// Five of seven are mostly refusing. X was only conspicuous for refusing
// completely. The others are BIMODAL, not thin — Facebook's twelve items all
// arrived in one week, Pinterest's eight in one week — which averages into
// something that reads like a quiet platform and is actually a platform whose
// question mostly doesn't fit.
//
// The real split is short-form video versus everything else. TikTok and
// Instagram Reels are the same medium and the generic prompt describes that
// medium exactly. The other five are five different mediums being asked the
// short-form-video question.
//
// So each of the five gets a frame. TikTok and Instagram deliberately get
// NONE: they are demonstrably working, and they are the last thing that should
// be touched. The tests assert both are unchanged.
//
// Every frame keeps specificity, citations, and the evergreen ban exactly as
// they are. These change WHAT COUNTS as a trend on a platform, never how
// rigorous the answer has to be — the risk in relaxing the macro rule is
// reopening the door constraint #4 guards, so each frame that relaxes it says
// so in its own text.
//
// These framings are reasoned, not measured. What IS measured is that the
// current frame is wrong for these five: it returns nothing five weeks in
// seven. `quiet_weeks` per platform is the check — if it does not fall for a
// given platform within a few cycles, that frame is wrong too and gets
// replaced with evidence rather than defended.
const PLATFORM_TREND_FRAME = {
  X: {
    // Replaces the generic "what to surface" list.
    whatCounts: [
      "  - Named debates or arguments the niche is actively having (the specific claim, not 'people are discussing X')",
      "  - Specific posts or threads driving that discussion — link the post",
      "  - Recurring post FORMATS gaining traction (thread structures, quote-post patterns, opening lines)",
      "  - Emerging terminology, coinages, or framings the niche has started using",
      "  - A news or industry development the niche is reacting to, where a creator could credibly add a take",
      "  - Accounts newly setting the agenda in this niche",
    ],
    // Replaces constraint #5. The specificity requirement is UNCHANGED — this
    // permits macro subjects, not vagueness. "AI is trending" is still
    // refused; "the argument about X's new API pricing splitting indie devs"
    // is a named subject with a citable post behind it.
    macroRule:
      "5. Macro and news topics ARE in scope on X — the conversation is the content here, and a creator's opening is a take on what the room is already arguing about. This does NOT relax specificity: name the actual claim, argument, or development and cite the post carrying it. 'AI is trending' is still useless; 'the thread arguing that AI SDRs are killing junior sales roles, 4k quote-posts' is exactly right.",
    // business.x.com / blog.x.com are advertiser and corporate-announcement
    // blogs — they carry product news, never creator trends. Pointing the
    // model at them spends its source budget on the wrong venue. Dropping them
    // falls through to SOURCE_HINTS_GENERAL, which names the platform itself
    // and Reddit, and for X those are genuinely where the signal is.
    dropPlatformHints: true,
  },

  LinkedIn: {
    // The other discourse platform, and the same diagnosis as X: professional
    // conversation is what LinkedIn runs on, and the generic rule forbids
    // reporting it. 4 of 6 weeks quiet, then 12 items in the weeks it fit.
    whatCounts: [
      "  - Specific arguments or positions the professional niche is debating right now (name the claim)",
      "  - Posts or articles driving that discussion — link the post",
      "  - Post FORMATS gaining traction (carousel structures, personal-story openings, contrarian takes, data-led posts)",
      "  - Industry developments, research, or announcements practitioners are reacting to",
      "  - Language and framings entering the niche's professional vocabulary",
      "  - People newly setting the agenda in this field",
    ],
    macroRule:
      "5. Industry-level and news topics ARE in scope on LinkedIn — professional commentary on what the field is discussing is the native content here. This does NOT relax specificity: name the actual claim, report, or development and cite the post or article carrying it. 'AI is changing recruiting' is useless; 'the report claiming AI screening cut interview-to-offer time 40%, and the pushback from recruiters in the comments' is right.",
  },

  YouTube: {
    // Not a trend-cycle platform. Topics and packaging move; sounds do not.
    // Search and recommendation demand is the signal.
    whatCounts: [
      "  - Video TOPICS or questions getting outsized search and view demand right now",
      "  - Title and thumbnail patterns doing well in this niche (describe the actual pattern)",
      "  - Format shifts — Shorts vs long-form, series concepts, episode structures, video lengths",
      "  - Specific videos that broke out recently in this niche, and what they did differently",
      "  - Emerging sub-topics creators in this niche have started covering",
      "  - Recurring hooks or opening structures in the first 15 seconds",
    ],
    // Macro stays excluded: YouTube demand IS niche-level, so the original
    // rule is correct here. Only the surface list changes.
  },

  Pinterest: {
    // Pinterest demand BUILDS. Users plan there — autumn searches climb from
    // midsummer — so a 14-day window discards the shape of the signal rather
    // than keeping it fresh, and the API-level recency filter would compound
    // it. This is the one platform where a longer look-back is more accurate,
    // not laxer.
    recencyDays: 45,
    searchRecency: "month",
    // A search engine with pictures. "What is being searched for" is the
    // trend; there is no trend CYCLE in the TikTok sense at all.
    whatCounts: [
      "  - Search terms and keyword themes gaining volume in this niche",
      "  - Seasonal or calendar-driven demand starting to climb (name the season and the search)",
      "  - Visual and aesthetic directions gaining traction (colour, styling, composition)",
      "  - Pin FORMATS performing well (idea pins, infographics, before/after, text overlay styles)",
      "  - Board and collection themes people are actively building",
      "  - Products or subjects being saved heavily in this niche",
    ],
    macroRule:
      "5. Pinterest is a SEARCH platform, so search demand and seasonal shifts are exactly what we want, not a distraction from it. This does NOT relax specificity: name the actual search term, season, or aesthetic and cite the source. 'Fall content is trending' is useless; 'searches for warm-toned kitchen renovations climbing ahead of autumn, per Pinterest's own trend data' is right.",
  },

  Facebook: {
    // Community and locality, not a discovery feed. Groups are the surface.
    whatCounts: [
      "  - Discussions gaining traction in Groups serving this niche (name the question being asked)",
      "  - Local, regional, or event-driven topics this audience is engaging with",
      "  - Post FORMATS working here (longer-form text, photo carousels, Reels crossposts, polls)",
      "  - Questions this audience keeps asking publicly that a creator could answer",
      "  - Community or seasonal moments the niche is organising around",
      "  - Specific posts driving unusual comment volume in this niche",
    ],
    macroRule:
      "5. Local, community and event-driven topics ARE in scope on Facebook — this is a community platform and its content opportunities are frequently local or seasonal rather than nationally trending. This does NOT relax specificity: name the actual discussion, event, or question and cite where it is happening. 'People are talking about the housing market' is useless; 'a Group thread asking whether to list before or after the school year, 300+ comments' is right.",
  },
};

export function buildTrendsPrompt(platform, opts) {
  const niche         = (opts && typeof opts.niche === "string") ? opts.niche.trim() : "";
  const excludeTrends = (opts && Array.isArray(opts.excludeTrends))
    ? opts.excludeTrends.filter(t => typeof t === "string" && t.trim()).slice(0, 15)
    : [];
  const frame         = PLATFORM_TREND_FRAME[platform] || null;
  const platformHints = (frame && frame.dropPlatformHints) ? [] : (SOURCE_HINTS_PLATFORM[platform] || []);
  const hintList      = [...platformHints, ...SOURCE_HINTS_GENERAL];

  // Niche header — when present, sharpens the whole search toward that
  // creator's vertical. When absent, prompt reads as a generic platform
  // trends scan (the cron's behavior).
  const nicheLine = niche
    ? "Niche focus: " + niche + " creators specifically. We want trends moving in THIS niche, not generic platform-wide signal. A trend that's hot on " + platform + " overall is not interesting; a trend that's hot among " + niche + " creators IS."
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
    frame
      ? "Surface up to 12 of the following. These are what a trend actually looks like on " + platform + " — do not look for TikTok-style micro-trends here, they do not exist on this platform and reporting their absence is not a useful answer:"
      : "Surface up to 12 of the following — prioritize micro-trends and emerging signals over established mainstream items:",
    ...(frame ? frame.whatCounts : [
      "  - Trending topics or themes",
      "  - Trending hashtags (specific ones, not '#fyp')",
      "  - Trending audio (where applicable to the platform)",
      "  - Emerging or surging content formats",
      "  - Specific hook or opening angles that are getting outsized engagement",
      "  - Sub-niche conversations gaining traction in the past 7-14 days",
    ]),
    "",
    frame
      ? "What we want: SPECIFIC, NAMED items with something citable behind them. Prefer what surfaced or escalated in the last 7-14 days over a subject that has been running for months."
      : "What we want: SPECIFIC, NAMED, recently-emerging items. A trend used by 500 creators last week and 5000 this week is FAR more valuable than one with 1M users that's been hot for a month.",
    "",
    excludeBlock,
    "",
    "Constraints:",
    "1. Sources: anything publicly visible. Prefer PRIMARY venues where the conversation is actually happening over publications that summarize it: " + hintList.join(", "),
    "1b. AVOID social-media-marketing recap publications (Sprout Social, Hootsuite, Buffer, Social Media Examiner, and their equivalents) as your PRIMARY evidence for an item. They aggregate each other, which means the same handful of trends resurfaces there every week — if every item you return traces back to one of those, the research has failed even when each item is individually true. Use them only to corroborate something you found at the source.",
    "2. Each item MUST cite an exact source URL — use the full https:// URL, not a citation marker like [1]. If the source is a TikTok / Reel / post, link to the post itself.",
    (frame && frame.recencyDays)
      ? "3. Skip anything older than " + frame.recencyDays + " days. Demand on this platform builds over weeks rather than spiking, so a search or theme climbing steadily over that window is signal — not staleness. Still prefer what is accelerating now over what has been flat for months."
      : "3. Skip anything older than 14 days — we want THIS WEEK's signal.",
    "4. STRICT exclusion of evergreen advice. 'Use trending audio,' 'post consistently,' 'engage with your audience' — these are rules, not trends. ONLY return specific named items.",
    (frame && frame.macroRule)
      ? frame.macroRule
      : "5. STRICT exclusion of mainstream/macro items unless they have a niche-specific angle. 'AI tools are trending' is not useful; 'Five specific AI tools getting traction in [niche] this week' is.",
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
  // [SEARCH-CONTROLS] This call was `sonar` with no search options — the
  // cheapest, shallowest configuration available — for the task in this
  // codebase that depends most on search depth. The prompt asks for
  // micro-trends "used by 500 creators last week and 5000 this week", which is
  // precisely the signal a shallow search cannot reach: it sits below the
  // threshold where recap publications have written it up yet.
  //
  //   sonar-pro    deeper retrieval, more sources per query
  //   recency=week matches constraint #3's 14-day rule at the search layer
  //     (Perplexity's coarser "month" would be looser than the prompt asks;
  //     "week" is tighter, which is the safe direction for a freshness rule)
  //   context=high the prompt requests 12 specific items with per-item
  //     citations, which needs the sources in context to answer honestly
  //
  // Cost: ~14 calls/week. sonar-pro is roughly 3x input / 15x output vs sonar
  // on the pricing sampled in perplexity.js, so this moves a rounding-error
  // line item to a slightly larger rounding-error line item. The weekly
  // research is the input to every generation's trend block; it is the wrong
  // place in this stack to be economizing.
  // Token budget slightly higher to accommodate 12 items vs the old 7.
  const frame = PLATFORM_TREND_FRAME[platform] || null;
  const result = await callPerplexity({
    prompt,
    model: "sonar-pro",
    maxTokens: 5000,
    // Per-frame where a platform's signal genuinely moves on a different
    // clock; "week" everywhere else.
    searchRecency: (frame && frame.searchRecency) || "week",
    searchDomains: EXCLUDED_RECAP_DOMAINS,
    searchContextSize: "high",
  });
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
