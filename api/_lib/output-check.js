// [OUTPUT-CHECK] The self-check rubric and the anti-slop rules, callable on
// finished text.
//
// Both have only ever lived INSIDE prompts: selfCheckFor() is a checklist the
// model reads before it answers, and STYLE_GUARD is a list of words it is told
// not to use. Neither could be run against an output. PR 1's strategy build
// needs exactly that — generate, check, regenerate once on failure — so this
// module wraps them without changing a word of either:
//
//   scanBannedPhrases(text)      deterministic. Finds STYLE_GUARD's banned
//                                vocabulary, the "not just X, it's Y" inversion,
//                                and em-dash overuse. Free, instant, no network.
//   gradeWithRubric(text, opts)  one fast-model call that applies the SAME
//                                selfCheckFor() checklist to the text and
//                                returns a verdict. Fail-open null when the
//                                key is missing or the call fails.
//   checkOutput(text, opts)      both, in one object.
//
// The rubric text and the banned list are imported, not copied, so a change
// to either prompt changes the check with it.

import { BANNED_VOCAB_GROUPS } from "./prompts.js";
import { selfCheckFor } from "./virl-persona.js";
import { callClaude } from "./anthropic.js";

// "leverage (as a verb)" carries a documentation qualifier in the prompt;
// strip it so the scan matches the word itself.
const BANNED_PHRASES = BANNED_VOCAB_GROUPS.flat().map(p => p.replace(/\s*\(.*?\)\s*$/, "").toLowerCase());

const INVERSION_RE  = /\b(it'?s|this is|that'?s|we'?re|i'?m)?\s*not just\b[^.!?\n]{1,80}?[—,.-]\s*(it'?s|this is|that'?s)?\s*\b/i;
const EMDASH_LIMIT  = 1; // STYLE_GUARD: "AT MOST one per substantive piece of copy"

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
const PHRASE_RES = BANNED_PHRASES.map(p => ({ phrase: p, re: new RegExp("\\b" + escapeRe(p).replace(/'/g, "['’]") + "\\b", "i") }));

// Pulls the prose out of a parsed JSON output (or takes a string as-is).
function asText(input) {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return input.map(asText).filter(Boolean).join("\n");
  if (typeof input === "object") return Object.values(input).map(asText).filter(Boolean).join("\n");
  return "";
}

export function scanBannedPhrases(input) {
  const text = asText(input);
  const phrases = PHRASE_RES.filter(x => x.re.test(text)).map(x => x.phrase);
  const emdashes = (text.match(/—/g) || []).length;
  const inversion = INVERSION_RE.test(text);
  const hits = phrases.slice();
  if (inversion) hits.push("\"not just X, it's Y\" inversion");
  if (emdashes > EMDASH_LIMIT) hits.push("em-dashes: " + emdashes + " (limit " + EMDASH_LIMIT + ")");
  return { pass: hits.length === 0, hits, phrases, emdashes, inversion };
}

// opts: { artifact, multi, model, context } — artifact/multi are passed
// straight to selfCheckFor so the checklist is the one the generating prompt
// carried; context is any creator material the VOICE item should compare
// against (voice samples, fingerprint block). Returns
// { pass, failures: [{ item, note }] } or null when unavailable.
export async function gradeWithRubric(input, opts) {
  const o = opts || {};
  const text = asText(input);
  if (!text.trim()) return null;
  const rubric = selfCheckFor({ artifact: o.artifact || "result", multi: !!o.multi });
  const system = "You are a reviewer applying a fixed checklist to a draft someone else wrote. "
    + "Judge only against the checklist. Reply with JSON only: "
    + "{\"pass\": boolean, \"failures\": [{\"item\": \"VOICE|TRENDS|STRATEGY|REPETITION|REGISTER|FORMAT|PERSONA\", \"note\": \"one sentence\"}]}. "
    + "An empty failures array means pass.";
  const prompt = "CHECKLIST (verbatim from the generating prompt):\n" + rubric
    + (o.context ? "\n\nCREATOR MATERIAL the VOICE item compares against:\n" + o.context : "")
    + "\n\nDRAFT TO REVIEW:\n" + text;
  const raw = await callClaude({ system, prompt, model: o.model, maxTokens: 600, temperature: 0 });
  if (!raw) return null;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : raw);
    const failures = Array.isArray(parsed.failures) ? parsed.failures.filter(f => f && typeof f.item === "string") : [];
    return { pass: failures.length === 0 && parsed.pass !== false, failures };
  } catch (e) {
    return null;
  }
}

export async function checkOutput(input, opts) {
  const o = opts || {};
  const banned = scanBannedPhrases(input);
  const rubric = o.grade === false ? null : await gradeWithRubric(input, o);
  return {
    pass: banned.pass && (rubric == null || rubric.pass),
    banned,
    rubric,
  };
}
