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

// Wraps one Perplexity chat completion. `prompt` is the user message; the
// returned object exposes the model's text reply, citations (URLs Perplexity
// pulled from during search), and token usage for cost telemetry parity with
// the rest of the stack.
export async function callPerplexity({ prompt, model, maxTokens, system }) {
  if (!PERPLEXITY_API_KEY) return null;
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + PERPLEXITY_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || "sonar",
        max_tokens: maxTokens || 3500,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: prompt },
        ],
      }),
    });
  } catch (e) {
    console.error("[perplexity] fetch threw", e.message);
    return null;
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
