// [COST 4] Perplexity Sonar wrapper used by the weekly research crons
// (trends + playbook). Perplexity executes its own web search inside the
// model call and returns a top-level `citations` array — no separate tool
// loop needed, which is why the migration is a single drop-in helper.
//
// Pricing reference (sampled January 2026):
//   Sonar:   ~$1/M input, ~$1/M output
//   Sonar-Pro: ~$3/M input, ~$15/M output
// For the weekly research workload (~14 calls/week) basic Sonar is plenty.
//
// Fail-open: returns null on any failure. Callers log and continue, so an
// outage degrades to "no fresh trends row this week" — plan generation
// still works against the most-recent valid row inside the existing
// TREND_FRESHNESS_DAYS window.

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const ENDPOINT           = "https://api.perplexity.ai/chat/completions";

// [RATE-LIMIT] A 429 is a RATE limit, not a bad-parameter rejection, and it is
// the one 4xx that gets strictly worse when you retry it immediately. Bounded
// exponential backoff with jitter, retrying the ORIGINAL request — the search
// options were never the problem, so stripping them (as the 4xx branch below
// does) throws away search quality without easing the limit.
const RATE_LIMIT_RETRIES  = 3;
const RATE_LIMIT_BASE_MS  = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [SEARCH-CONTROLS] Perplexity enforces recency, source selection, and search
// depth as REQUEST PARAMETERS. Until now this wrapper sent none of them, so
// every one of those constraints was expressed in prose inside the prompt and
// left to the model's discretion — see constraints #1, #1b and #3 in
// trends-research.js, which ask in English for exactly what the three options
// below enforce at the search layer. Asking a model to restrict its own search
// results is not the same as restricting them.
//
//   searchRecency     → search_recency_filter: "day" | "week" | "month"
//   searchDomains     → search_domain_filter: allow-list, or deny-list when an
//                       entry is prefixed with "-". Documented cap is 10
//                       entries; callers must pre-trim.
//   searchContextSize → web_search_options.search_context_size:
//                       "low" | "medium" | "high"
//
// All three are optional and omitted entirely when not supplied, so existing
// callers are unaffected.
function buildBody({ prompt, model, maxTokens, system, searchRecency, searchDomains, searchContextSize }) {
  const body = {
    model: model || "sonar",
    max_tokens: maxTokens || 3500,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ],
  };
  if (searchRecency) body.search_recency_filter = searchRecency;
  if (Array.isArray(searchDomains) && searchDomains.length) {
    body.search_domain_filter = searchDomains.slice(0, 10);
  }
  if (searchContextSize) body.web_search_options = { search_context_size: searchContextSize };
  return body;
}

async function post(body) {
  return fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + PERPLEXITY_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// Wraps one Perplexity chat completion. `prompt` is the user message; the
// returned object exposes the model's text reply, citations (URLs Perplexity
// pulled from during search), and token usage for cost telemetry parity with
// the rest of the stack.
export async function callPerplexity(opts) {
  if (!PERPLEXITY_API_KEY) return null;
  const { prompt, model, maxTokens, system, searchRecency, searchDomains, searchContextSize } = opts || {};
  const full = buildBody({ prompt, model, maxTokens, system, searchRecency, searchDomains, searchContextSize });
  const usedSearchOpts = !!(searchRecency || searchContextSize ||
    (Array.isArray(searchDomains) && searchDomains.length));

  let res;
  try {
    res = await post(full);
  } catch (e) {
    console.error("[perplexity] fetch threw", e.message);
    return null;
  }

  // [SEARCH-CONTROLS] `search_domain_filter` has historically been gated to
  // certain usage tiers, and parameter names drift between API versions. A
  // 400 caused by one of these options would otherwise take out the entire
  // weekly research run — a strictly worse outcome than the un-filtered
  // search we had before. So on a 4xx, retry ONCE without them and log
  // loudly: degraded search beats no trends row, but a silent downgrade is
  // how you end up believing a filter is on when it never applied.
  // [RATE-LIMIT] Drain a 429 before anything else looks at the status. The
  // weekly refresh fires REFRESH_CONCURRENCY research calls at once; on
  // 2026-08-22 that tripped Perplexity's request rate limit and 23 of 27 jobs
  // died on the first 429, because the branch below treated it as a rejected
  // search option and instantly re-sent the request — doubling the request
  // rate against an already-tripped limit. Back off instead.
  for (let attempt = 0; !res.ok && res.status === 429 && attempt < RATE_LIMIT_RETRIES; attempt++) {
    const waitMs = RATE_LIMIT_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 400);
    console.warn(
      "[perplexity] 429 rate limited — backing off " + waitMs + "ms " +
      "(attempt " + (attempt + 1) + "/" + RATE_LIMIT_RETRIES + ")",
    );
    await sleep(waitMs);
    try {
      res = await post(full);
    } catch (e) {
      console.error("[perplexity] rate-limit retry threw", e.message);
      return null;
    }
  }

  if (!res.ok && usedSearchOpts && res.status >= 400 && res.status < 500 && res.status !== 429) {
    const errText = await res.text().catch(() => "");
    console.error(
      "[perplexity] search options rejected (" + res.status + ") — retrying WITHOUT " +
      "recency/domain/context filters. Search is now unfiltered for this call.",
      errText.slice(0, 300),
    );
    try {
      res = await post(buildBody({ prompt, model, maxTokens, system }));
    } catch (e) {
      console.error("[perplexity] retry threw", e.message);
      return null;
    }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("[perplexity] error", res.status, errText);
    return null;
  }
  let body;
  try { body = await res.json(); } catch (e) { return null; }
  const choice = body && Array.isArray(body.choices) ? body.choices[0] : null;
  const text   = (choice && choice.message && typeof choice.message.content === "string")
    ? choice.message.content
    : "";
  // Perplexity sometimes returns `citations` and sometimes `search_results`
  // (newer responses) — coalesce both into a flat URL array. De-dup to
  // protect downstream consumers from inflated source counts.
  const rawCitations = Array.isArray(body.citations) ? body.citations : [];
  const fromSearch   = Array.isArray(body.search_results)
    ? body.search_results.map(r => r && r.url).filter(Boolean)
    : [];
  const seen = new Set();
  const citations = [];
  for (const url of [...rawCitations, ...fromSearch]) {
    if (typeof url !== "string" || !url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    citations.push(url);
  }
  return {
    text,
    citations,
    usage: body.usage || null,
  };
}

// Best-effort JSON extraction shared by the research workers. Mirrors the
// shape used by the old Anthropic callers so the prompt contract (return
// JSON) doesn't need to change.
export function tryParseJSON(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (e) { /* fall through */ }
  }
  try { return JSON.parse(text.trim()); } catch (e) {}
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}
