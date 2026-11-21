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

// [PR1] Optional extras for the strategist calls (api/strategy.js):
//   outputSchema — a JSON schema; the reply is constrained to it via
//                  output_config.format (structured outputs), so the text
//                  is always parseable JSON.
//   effort       — output_config.effort ("low" | "medium" | "high" | ...).
//                  The 5.x models think adaptively by default; effort is the
//                  depth control. Never pass `temperature` with them.
//   fallbacks    — true opts into the server-side refusal fallback: a policy
//                  decline re-runs on a fallback model inside the same call.
// [A2] The 5.x models (and anything newer) reject `temperature` with a 400
// ("`temperature` is deprecated for this model"). callClaude fails open, so
// every caller that passed one was silently returning null: voice checks,
// the output rubric, and (once MODEL_SONNET moves to 5.x) research
// verification. Strip it here, once, so no call site can reintroduce it.
// Matches claude-<family>-<major>[-<minor>] for any major version >= 5, plus
// Opus 4.7 / 4.8, which dropped sampling parameters first. Sonnet 4.6 and
// Haiku 4.5 still accept temperature on the API version this file pins.
const MODEL_VERSION_RE = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/i;
export function modelRejectsTemperature(model) {
  const m = MODEL_VERSION_RE.exec(String(model || ""));
  if (!m) return false;
  const major = parseInt(m[2], 10);
  const minor = m[3] && m[3].length <= 2 ? parseInt(m[3], 10) : 0; // ignore date suffixes
  if (major >= 5) return true;
  return m[1].toLowerCase() === "opus" && major === 4 && minor >= 7;
}

export const DEFAULT_MODEL = "claude-sonnet-4-6";

// Builds the Messages API request body. Exported so
// scripts/check-anthropic-params.mjs can assert on it without a network call.
export function buildRequestBody({ system, prompt, model, maxTokens, temperature, outputSchema, effort, fallbacks }) {
  const useModel = model || DEFAULT_MODEL;
  const outputConfig = {};
  if (outputSchema) outputConfig.format = { type: "json_schema", schema: outputSchema };
  if (effort)       outputConfig.effort = effort;
  const sendTemperature = typeof temperature === "number" && !modelRejectsTemperature(useModel);
  return {
    model:       useModel,
    max_tokens:  maxTokens || 1500,
    ...(sendTemperature ? { temperature } : {}),
    ...(system ? { system } : {}),
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    ...(fallbacks ? { fallbacks: "default" } : {}),
    messages: [{ role: "user", content: prompt }],
  };
}

export async function callClaude(opts) {
  const { prompt, fallbacks } = opts || {};
  if (!ANTHROPIC_API_KEY) return null;
  if (!prompt || typeof prompt !== "string") return null;

  const headers = {
    "x-api-key":         ANTHROPIC_API_KEY,
    "anthropic-version": API_VERSION,
    "Content-Type":      "application/json",
  };
  if (fallbacks) headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
  const requestBody = buildRequestBody(opts);

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
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
    model:      body.model || requestBody.model,
  };
}

// Parses a JSON object out of a model reply that may be wrapped in prose
// or a ```json fence. Returns null rather than throwing — callers treat a
// parse failure exactly like a failed call.
//
// [A1] Tries, in order: the whole reply, each fenced block, then the span
// from the first "{" to the last "}". The old version took the FIRST fence
// anywhere in the text, so a plan whose caption contained backticks parsed
// the caption's fence instead of the plan and returned null.
function asObject(s) {
  try {
    const v = JSON.parse(s);
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
  } catch (e) { return null; }
}
export function extractJsonObject(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  const whole = asObject(s);
  if (whole) return whole;
  const fences = s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const m of fences) {
    const inner = m[1].trim();
    if (inner[0] !== "{") continue;
    const v = asObject(inner);
    if (v) return v;
  }
  const start = s.indexOf("{");
  const end   = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return asObject(s.slice(start, end + 1));
}
