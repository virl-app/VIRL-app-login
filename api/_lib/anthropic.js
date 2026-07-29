// [ANTHROPIC-HELPER] Minimal non-streaming Claude wrapper for server-side
// calls that are NOT user generations — background verification, cleanup,
// and QA passes that run inside another endpoint's request.
//
// api/chat.js deliberately keeps its own inline fetch: it owns credit
// accounting, prompt caching, streaming, truncation retries, and
// usage_events telemetry, none of which belongs in a shared helper. This
// module is the peer of _lib/perplexity.js — one call, no side effects,
// fail-open null — for the small internal passes that just need an answer.
//
// Fail-open contract: returns null on a missing key, a network error, a
// non-2xx response, or an empty completion. Every caller must treat null
// as "verification unavailable" and fall through to its own degraded
// path, never as an error worth failing the user's request over.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ENDPOINT          = "https://api.anthropic.com/v1/messages";
const API_VERSION       = "2023-06-01";

export async function callClaude({ system, prompt, model, maxTokens, temperature }) {
  if (!ANTHROPIC_API_KEY) return null;
  if (!prompt || typeof prompt !== "string") return null;

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": API_VERSION,
        "Content-Type":      "application/json",
      },
      body: JSON.stringify({
        model:       model || "claude-sonnet-4-6",
        max_tokens:  maxTokens || 1500,
        ...(typeof temperature === "number" ? { temperature } : {}),
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (e) {
    console.error("[anthropic] fetch threw", e.message);
    return null;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("[anthropic] error", res.status, errText.slice(0, 400));
    return null;
  }

  let body;
  try { body = await res.json(); } catch (e) { return null; }

  const text = Array.isArray(body && body.content)
    ? body.content.filter(b => b && b.type === "text").map(b => b.text).join("")
    : "";
  if (!text.trim()) return null;

  return {
    text:       text.trim(),
    stopReason: body.stop_reason || null,
    usage:      body.usage || null,
  };
}

// Parses a JSON object out of a model reply that may be wrapped in prose
// or a ```json fence. Returns null rather than throwing — callers treat a
// parse failure exactly like a failed call.
export function extractJsonObject(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  if (s[0] !== "{") {
    const start = s.indexOf("{");
    const end   = s.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    s = s.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(s);
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : null;
  } catch (e) { return null; }
}
