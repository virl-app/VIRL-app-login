// /api/_lib/voice-drift.js
// ─────────────────────────────────────────────────────────────────────────────
// [VOICE-DRIFT] Server-side stylometric telemetry. Compares features of the
// model's generated output against the user's sampleCaption reference text
// and emits a `virl_voice_drift` event (JSON line to stdout, same pattern as
// virl_usage / virl_compliance). The number is a relative trend signal — it
// lets us see whether prompt / cache changes are pulling the model away from
// the user's voice, not an absolute "this output sounds like X" verdict.
//
// Why per-feature deltas and not a single similarity model:
//   - Pure JS, no network call, ~1ms per generation. Won't slow responses.
//   - Stylometric features (sentence length, contractions, em-dashes, etc.)
//     are what an LLM controls when it imitates voice. Each one is a
//     dimension where drift can hide. Logging all deltas lets us spot WHICH
//     axis drifted, not just THAT drift happened.
//   - Score is intentionally bounded 0-100 so trend lines are comparable
//     across users with very different baselines.
//
// Output is fail-soft: returns null when there isn't enough text on either
// side to compute meaningful features. Callers must handle null.
// ─────────────────────────────────────────────────────────────────────────────

// JSON keys in generated plan / caption / script payloads that carry the
// user-facing prose. Everything else (designDirection, audioRecommendation,
// slideNumber, format hints, etc.) is directorial metadata that doesn't
// represent the user's voice and would skew the features.
const VOICE_BEARING_KEYS = new Set([
  // Plan card variants
  "caption", "hook", "body", "closing", "headline", "quote",
  "onScreenText",
  // Script + remix
  "script", "spokenLine", "voiceover", "remix",
  // Carousel slides nest headline/body which are picked up by recursion.
]);

// Pull the prose-only text out of a parsed JSON output. Recurses into nested
// objects / arrays so slides, cards, and array-of-strings shapes all flatten
// into one corpus for featurization.
export function extractVoiceText(parsed) {
  if (parsed == null) return "";
  if (typeof parsed === "string") return parsed;
  if (typeof parsed === "number" || typeof parsed === "boolean") return "";
  if (Array.isArray(parsed)) return parsed.map(extractVoiceText).filter(Boolean).join("\n");
  if (typeof parsed === "object") {
    const parts = [];
    for (const [k, v] of Object.entries(parsed)) {
      if (VOICE_BEARING_KEYS.has(k)) {
        parts.push(extractVoiceText(v));
      } else if (v && typeof v === "object") {
        // Recurse into containers (cards array, slides array, etc.) without
        // adding the container key's own non-voice content.
        parts.push(extractVoiceText(v));
      }
    }
    return parts.filter(Boolean).join("\n");
  }
  return "";
}

// Word tokens: lowercase letter runs, contractions kept glued ("I'm" → "i'm").
function tokenize(text) {
  return text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
}

// Sentence count: split on terminal punctuation followed by whitespace or EOL.
// Crude but stable across the variety of model outputs we see.
function sentenceCount(text) {
  const parts = text.split(/[.!?]+(?:\s+|$)/).filter(s => s.trim().length > 0);
  return Math.max(1, parts.length);
}

const EMOJI_RE       = /\p{Extended_Pictographic}/gu;
const EMDASH_RE      = /—/g;
const CONTRACTION_RE = /\b\w+'(s|re|ve|m|d|ll|t)\b/gi;
const ALLCAPS_RE     = /\b[A-Z]{2,}\b/g;

// Stylometric feature vector. Returns null for inputs too short to be stable.
function featurize(text) {
  if (!text || typeof text !== "string") return null;
  const words = tokenize(text);
  const wordCount = words.length;
  // Below 20 words the per-100 rates are too noisy to trend on. SampleCaption
  // is often around 30-100 words; generated plans are usually 200+. If the
  // reference is too thin, the comparison isn't meaningful.
  if (wordCount < 20) return null;

  const sents = sentenceCount(text);
  const per100 = (n) => (n * 100) / wordCount;

  return {
    wordCount,
    avgSentLen:   +(wordCount / sents).toFixed(2),
    avgWordLen:   +(words.reduce((s, w) => s + w.length, 0) / wordCount).toFixed(2),
    contractRate: +per100((text.match(CONTRACTION_RE) || []).length).toFixed(2),
    exclamRate:   +per100((text.match(/!/g) || []).length).toFixed(2),
    questionRate: +per100((text.match(/\?/g) || []).length).toFixed(2),
    emdashRate:   +per100((text.match(EMDASH_RE) || []).length).toFixed(2),
    emojiRate:    +per100((text.match(EMOJI_RE) || []).length).toFixed(2),
    allcapsRate:  +per100((text.match(ALLCAPS_RE) || []).length).toFixed(2),
  };
}

// Per-feature normalization: roughly the magnitude of difference that counts
// as "this axis drifted." Each feature's contribution to the score saturates
// at its norm, so no single outlier dominates. Tuned by hand; revisit once
// we have a week of production data.
const FEATURE_NORMS = {
  avgSentLen:   8,
  avgWordLen:   1.5,
  contractRate: 5,
  exclamRate:   3,
  questionRate: 3,
  emdashRate:   1,
  emojiRate:    4,
  allcapsRate:  2,
};

// Compute the drift score + per-feature deltas. Returns null when either
// side is too thin to featurize. Score is 0 (identical) to 100 (every axis
// ≥ its norm).
export function computeVoiceDrift(generatedText, referenceText) {
  const ref = featurize(referenceText);
  const gen = featurize(generatedText);
  if (!ref || !gen) return null;

  const deltas = {};
  let sumNorm = 0;
  let featCount = 0;
  for (const [feat, norm] of Object.entries(FEATURE_NORMS)) {
    const delta = Math.abs(gen[feat] - ref[feat]);
    deltas[feat] = +delta.toFixed(2);
    sumNorm += Math.min(1, delta / norm);
    featCount++;
  }
  const score = +((sumNorm / featCount) * 100).toFixed(1);

  return {
    score,
    ref: { wordCount: ref.wordCount },
    gen: { wordCount: gen.wordCount },
    deltas,
  };
}
