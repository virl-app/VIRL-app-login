// [VOICE-EVAL-LIVE] The LLM-in-the-loop companion to check-voice.mjs.
// Golden profiles → real generations → deterministic drift scoring against
// each profile's own reference corpus. Run nightly or before/after any
// model/prompt change (e.g. the PLAN_MODEL_OVERRIDE Opus experiment):
//
//   ANTHROPIC_API_KEY=sk-... node scripts/voice-eval-nightly.mjs
//
// Profiles: scripts/voice-eval-profiles.json (gitignored — contains real
// user text; copy voice-eval-profiles.example.json to start). Output: a
// per-profile, per-surface drift table + run averages. Lower = closer to
// the creator's voice. Track the trend, not any single number.

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { dispatch } from "../api/_lib/prompts.js";
import { computeVoiceDrift, extractVoiceText } from "../api/_lib/voice-drift.js";

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error("Set ANTHROPIC_API_KEY."); process.exit(1); }

const PROFILES_PATH = new URL("./voice-eval-profiles.json", import.meta.url);
if (!existsSync(PROFILES_PATH)) {
  console.error("Missing scripts/voice-eval-profiles.json — copy the .example.json and fill in real profiles.");
  process.exit(1);
}
const profiles = JSON.parse(readFileSync(PROFILES_PATH, "utf8"));

const SURFACES = [
  { label: "caption", gt: "caption", params: (p) => ({ platform: "Instagram", topic: p.evalTopic || "a small win from this week", niche: p.niche }) },
  { label: "long_post", gt: "long_post", params: (p) => ({ topic: p.evalTopic || "a lesson from this week", length: "medium", niche: p.niche }) },
];

function flatten(sp) {
  if (typeof sp === "string") return sp;
  return sp ? (sp.shared || "") + "\n" + (sp.perUser || "") : "";
}

async function generate(built) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: built.model,
      max_tokens: Math.min(built.maxTokens || 1200, 2000),
      system: flatten(built.systemPrompt),
      messages: [{ role: "user", content: built.userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return (body.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

const rows = [];
for (const p of profiles) {
  const reference = [p.sampleCaption, ...(p.voiceSamples || []), ...(p.handlePostExcerpts || [])]
    .filter(Boolean).join("\n\n");
  for (const s of SURFACES) {
    const built = dispatch(s.gt, s.params(p), p, null, {}, {}, [], null, null, null);
    try {
      const text = await generate(built);
      let gen = text;
      try { gen = extractVoiceText(JSON.parse(text)); } catch (e) { /* plain text ok */ }
      const drift = computeVoiceDrift(gen, reference);
      rows.push({ profile: p.name, surface: s.label, model: built.model, drift: drift ? drift.score : null });
      console.log(`${p.name.padEnd(16)} ${s.label.padEnd(10)} ${built.model.padEnd(28)} drift: ${drift ? drift.score.toFixed(1) : "n/a"}`);
    } catch (e) {
      rows.push({ profile: p.name, surface: s.label, model: built.model, drift: null, error: e.message });
      console.log(`${p.name.padEnd(16)} ${s.label.padEnd(10)} ERROR ${e.message}`);
    }
  }
}
const scored = rows.filter(r => r.drift != null);
const avg = scored.length ? scored.reduce((a, r) => a + r.drift, 0) / scored.length : null;
console.log(`\nRun average drift: ${avg != null ? avg.toFixed(1) : "n/a"} across ${scored.length} generations (lower = closer to voice).`);
appendFileSync(new URL("./voice-eval-history.jsonl", import.meta.url),
  JSON.stringify({ at: new Date().toISOString(), planModelOverride: process.env.PLAN_MODEL_OVERRIDE || null, avg, rows }) + "\n");
console.log("Appended to scripts/voice-eval-history.jsonl");
