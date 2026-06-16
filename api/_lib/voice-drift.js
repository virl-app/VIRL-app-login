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

// ─────────────────────────────────────────────────────────────────────────────
// [VOICE-FINGERPRINT] Same featurize() shape used by drift telemetry,
// surfaced two ways:
//   1. Server: rendered into the per-user system prompt as concrete
//      categorical instructions ("Heavy contractions (~6/100 words). Short
//      sentences (avg 7 words). Em-dash averse.") so the model has explicit,
//      numeric anchors for the user's voice register — not just the
//      qualitative "match this caption" gesture from sampleCaption.
//   2. Client: same computation runs in index.html on profile load and
//      surfaces as a "Your voice fingerprint" panel. Same numbers, same
//      labels — gives the user transparency into what VIRL learned from
//      their reference text, and a validation moment ("yes that's me") or
//      a nudge to add more samples if the readout feels off.
//
// Both sides derive the fingerprint from sampleCaption + voiceSamples (the
// text the user explicitly authored as voice reference). Vault exemplars
// and Perplexity excerpts feed drift measurement but NOT the fingerprint —
// the fingerprint must be derivable from text the user can see and edit,
// otherwise the client mirror can't reproduce it and the panel becomes a
// black box.
// ─────────────────────────────────────────────────────────────────────────────

// Thresholds for categorical labels. Tuned so the labels read true for the
// typical creator-voice sample (sampleCaption is usually 30-150 words; the
// rates here match what natural social copy actually looks like, not formal
// prose). Buckets are intentionally tri-state ("heavy / typical / averse")
// because finer granularity reads as false precision on a 50-word sample.
const FINGERPRINT_BUCKETS = {
  contractRate: { heavy: 4,    averse: 1   },  // per 100 words
  exclamRate:   { heavy: 2,    averse: 0.5 },
  questionRate: { heavy: 2,    averse: 0.5 },
  emdashRate:   { heavy: 0.5,  averse: 0   },  // any em-dashes at all is notable
  emojiRate:    { heavy: 2,    averse: 0.3 },
  allcapsRate:  { heavy: 1,    averse: 0.2 },
};
const SENT_LEN_SHORT = 10;   // words/sentence
const SENT_LEN_LONG  = 22;

function bucket(rate, cuts) {
  if (rate >= cuts.heavy)  return "heavy";
  if (rate <= cuts.averse) return "averse";
  return "typical";
}

// Public: compute a fingerprint from any voice-reference text. Returns null
// when the input is below featurize()'s 20-word minimum (same gate the
// drift signal uses; below that the per-100 rates are too noisy to label).
export function computeVoiceFingerprint(text) {
  const f = featurize(text);
  if (!f) return null;

  const labels = {
    contractions: bucket(f.contractRate, FINGERPRINT_BUCKETS.contractRate),
    exclamations: bucket(f.exclamRate,   FINGERPRINT_BUCKETS.exclamRate),
    questions:    bucket(f.questionRate, FINGERPRINT_BUCKETS.questionRate),
    emdashes:     bucket(f.emdashRate,   FINGERPRINT_BUCKETS.emdashRate),
    emojis:       bucket(f.emojiRate,    FINGERPRINT_BUCKETS.emojiRate),
    allcaps:      bucket(f.allcapsRate,  FINGERPRINT_BUCKETS.allcapsRate),
    sentenceLen:  f.avgSentLen <= SENT_LEN_SHORT ? "short"
                : f.avgSentLen >= SENT_LEN_LONG  ? "long"
                : "medium",
  };

  return {
    wordCount:    f.wordCount,
    avgSentLen:   f.avgSentLen,
    avgWordLen:   f.avgWordLen,
    contractRate: f.contractRate,
    exclamRate:   f.exclamRate,
    questionRate: f.questionRate,
    emdashRate:   f.emdashRate,
    emojiRate:    f.emojiRate,
    allcapsRate:  f.allcapsRate,
    labels,
  };
}

// Render the fingerprint as a concrete, prompt-ready instruction block.
// Returns "" when fp is null so callers can concat unconditionally.
//
// Format is "<axis>: <imperative + numeric anchor>." per line — concrete
// numbers backstop the categorical label. The model gets both signals:
// "Heavy contractions" tells it the register; "~6 per 100 words" gives it
// a target rate to roughly hit without over-fitting to an exact count.
export function formatFingerprintForPrompt(fp) {
  if (!fp) return "";
  const lines = [];

  // Contractions — the highest-leverage axis. The STYLE_GUARD already
  // pushes "use contractions by default"; this either reinforces or
  // overrides depending on the creator's actual register.
  if (fp.labels.contractions === "heavy") {
    lines.push("  - Contractions: heavy use (~" + fp.contractRate + " per 100 words). \"I'm,\" \"don't,\" \"it's,\" \"you're,\" \"we'll.\" Almost never spell them out.");
  } else if (fp.labels.contractions === "averse") {
    lines.push("  - Contractions: this creator writes them out (~" + fp.contractRate + " per 100 words). Prefer \"I am,\" \"do not,\" \"it is\" — only contract when the rhythm demands it.");
  } else {
    lines.push("  - Contractions: typical mix (~" + fp.contractRate + " per 100 words). Default to contractions; spell out occasionally for emphasis.");
  }

  // Sentence length
  if (fp.labels.sentenceLen === "short") {
    lines.push("  - Sentence length: short (avg " + fp.avgSentLen + " words). Punchy. Fragmented. One idea per beat.");
  } else if (fp.labels.sentenceLen === "long") {
    lines.push("  - Sentence length: long (avg " + fp.avgSentLen + " words). Lets a thought breathe and unfold across clauses.");
  } else {
    lines.push("  - Sentence length: medium (avg " + fp.avgSentLen + " words). Mix punchy lines with longer thoughts.");
  }

  // Em-dashes — major AI tell, so the fingerprint's call here trumps the
  // generic "AT MOST one per piece" rule from STYLE_GUARD when the user
  // actually uses them.
  if (fp.labels.emdashes === "heavy") {
    lines.push("  - Em-dashes: this creator uses them (~" + fp.emdashRate + " per 100 words). Use sparingly but don't avoid them — they're part of the voice.");
  } else {
    lines.push("  - Em-dashes: averse — the creator's reference text has effectively none. Do NOT use em-dashes. Default to commas, periods, or colons.");
  }

  // Exclamations
  if (fp.labels.exclamations === "heavy") {
    lines.push("  - Exclamations: high-energy (~" + fp.exclamRate + " per 100 words). Match the enthusiasm; don't dial it down to look professional.");
  } else if (fp.labels.exclamations === "averse") {
    lines.push("  - Exclamations: rare (~" + fp.exclamRate + " per 100 words). Default to periods. Reserve \"!\" for the moment that genuinely warrants it.");
  }

  // Emojis — only emit when the fingerprint is decisive; otherwise the
  // EMOJI_RULE already in buildProfileCtx covers it.
  if (fp.labels.emojis === "heavy") {
    lines.push("  - Emojis: heavy use (~" + fp.emojiRate + " per 100 words). Weave them naturally throughout, not just at the end.");
  } else if (fp.labels.emojis === "averse") {
    lines.push("  - Emojis: rare or none in the reference. Don't sprinkle them in unless the emoji preference setting says otherwise.");
  }

  // All-caps emphasis
  if (fp.labels.allcaps === "heavy") {
    lines.push("  - ALL CAPS: this creator uses caps for emphasis (~" + fp.allcapsRate + " per 100 words). Mirror the pattern when emphasis lands.");
  }

  // Questions
  if (fp.labels.questions === "heavy") {
    lines.push("  - Questions: this creator engages directly (~" + fp.questionRate + " per 100 words). Use questions to pull readers in.");
  }

  return "VOICE FINGERPRINT (derived from this creator's own reference text — these are the registers their words actually use; match them):\n"
    + lines.join("\n");
}
