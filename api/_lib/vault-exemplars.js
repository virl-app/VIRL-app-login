// /api/_lib/vault-exemplars.js
// ─────────────────────────────────────────────────────────────────────────────
// [VAULT-EXEMPLARS] Picks the N best few-shot exemplars for a generation by
// joining the user's vault (things they saved — taste signal) with their
// results (things they posted — validation signal). Vault tells us what the
// creator likes; results tell us what worked. Items present in BOTH are the
// strongest signal: the creator chose to ship it AND it represented their
// voice well enough to save.
//
// Selection algorithm:
//   1. Index results by id, then walk vault. Each vault item gets paired
//      with its result entry (if any). Vault items with content always
//      qualify.
//   2. Add result-only items (logged but never saved to vault) that carry
//      voice-bearing fields — those are forward-only because logResult
//      only started capturing hook/description after this PR ships.
//   3. Rank: (has_result, has_content_quality, saved_recently). Items the
//      user both saved AND posted come first; result-only-with-content
//      second; vault-only-no-result third.
//   4. Compute a per-result "performed well" tag based on the user's own
//      median engagement (views, falling back to likes, falling back to
//      saves). Median is only meaningful with 4+ logged results; below
//      that the tag is suppressed entirely.
//   5. Slice top N (default 5). The few-shot prompt block in prompts.js
//      renders them as voice references the model should align with —
//      NOT copy. Variety + voice fidelity, not regurgitation.
// ─────────────────────────────────────────────────────────────────────────────

// Pull the numeric engagement score from a result entry. Result shape is
// {views, likes, saves}; any field can be a string ("1.2k") or undefined.
// We coerce loosely — non-numeric strings become 0.
function engagementScore(result) {
  if (!result || typeof result !== "object") return 0;
  const pick = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const cleaned = v.replace(/[,_\s]/g, "").toLowerCase();
      const m = cleaned.match(/^([\d.]+)([kmb])?$/);
      if (!m) return 0;
      const n = parseFloat(m[1]);
      if (!Number.isFinite(n)) return 0;
      const mult = m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : 1;
      return n * mult;
    }
    return 0;
  };
  // Prefer views (most universally comparable); fall back to likes, then
  // saves. A user who only logs likes still gets a sensible score.
  return pick(result.views) || pick(result.likes) || pick(result.saves);
}

// Build a flat exemplar pool from the (vault, results) pair. Each entry is
// an object with: id, source ("vault" | "result" | "both"), title, platform,
// format, hook, description, performanceTag ("well" | null), recencyTs
// (used for sort).
function buildExemplarPool(vault, results) {
  const safeVault   = Array.isArray(vault)   ? vault   : [];
  const safeResults = Array.isArray(results) ? results : [];

  const resultById = {};
  for (const r of safeResults) {
    if (r && r.id != null) resultById[r.id] = r;
  }

  // ── Median engagement for the "performed well" tag ─────────────────────
  // Only computed when there are 4+ logged results — fewer than that and
  // the median isn't a meaningful threshold. Below the floor we just leave
  // the performanceTag null on every exemplar.
  let medianEngagement = null;
  const scoredResults = safeResults
    .map(r => engagementScore(r && r.result))
    .filter(s => s > 0)
    .sort((a, b) => a - b);
  if (scoredResults.length >= 4) {
    const mid = Math.floor(scoredResults.length / 2);
    medianEngagement = scoredResults.length % 2 === 0
      ? (scoredResults[mid - 1] + scoredResults[mid]) / 2
      : scoredResults[mid];
  }
  function tagFor(result) {
    if (!result || medianEngagement == null) return null;
    return engagementScore(result) > medianEngagement ? "well" : null;
  }

  // Vault items first — they always have content (description/hook).
  const seen = {};
  const pool = [];
  for (const v of safeVault) {
    if (!v || v.id == null) continue;
    const matchedResult = resultById[v.id];
    const description = v.description || v.text || null;
    const hook        = v.hook        || null;
    // Skip vault items without ANY voice-bearing content. A title alone
    // tells the model nothing about voice.
    if (!description && !hook) continue;
    pool.push({
      id:             v.id,
      source:         matchedResult ? "both" : "vault",
      title:          v.title    || null,
      platform:       v.platform || null,
      format:         v.format   || null,
      hook,
      description,
      performanceTag: matchedResult ? tagFor(matchedResult.result) : null,
      // Vault items use savedAt; fall back to current time so a missing
      // field doesn't push them to the epoch.
      recencyTs:      Date.parse(v.savedAt || "") || 0,
    });
    seen[v.id] = true;
  }

  // Result-only items: posted but never saved. These need voice-bearing
  // fields (hook / description) on the result entry itself — captured by
  // logResult starting with this PR. Older results entries that pre-date
  // the capture get skipped here and contribute only via the vault path.
  for (const r of safeResults) {
    if (!r || r.id == null || seen[r.id]) continue;
    const description = r.description || null;
    const hook        = r.hook        || null;
    if (!description && !hook) continue;
    pool.push({
      id:             r.id,
      source:         "result",
      title:          r.title    || null,
      platform:       r.platform || null,
      format:         r.format   || null,
      hook,
      description,
      performanceTag: tagFor(r.result),
      recencyTs:      Date.parse(r.loggedAt || "") || 0,
    });
  }

  // Rank: posted-and-saved > result-only > vault-only; then by recency.
  const sourceRank = { both: 0, result: 1, vault: 2 };
  pool.sort((a, b) => {
    const sa = sourceRank[a.source] ?? 3;
    const sb = sourceRank[b.source] ?? 3;
    if (sa !== sb) return sa - sb;
    return b.recencyTs - a.recencyTs;
  });

  return pool;
}

// Public: returns up to N exemplars from (vault, results). Caller should
// pass through whatever shape it has — both arrays default to [] on
// undefined / non-array inputs. Returns [] when no usable exemplars exist
// (new user, no content captured yet, etc.), so the prompt builder can
// cleanly skip the section.
export function selectVaultExemplars(vault, results, count = 5) {
  const pool = buildExemplarPool(vault, results);
  return pool.slice(0, count);
}

// Cap each exemplar's caption at this many characters in the prompt. A
// LinkedIn long-form save could easily push 800+ words and blow the
// per-user cache block past Anthropic's minimum-to-cache threshold and
// into wasted tokens. ~400 chars (≈80 words) preserves enough voice
// signal while keeping 5 exemplars under ~750 tokens total. The drift
// reference path (exemplarsAsVoiceText) keeps full text because
// stylometric features are length-sensitive.
const CAPTION_MAX_CHARS = 400;
const HOOK_MAX_CHARS    = 200;

function truncateForPrompt(text, max) {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  // Hard cut at max minus 1 char + ellipsis. Word-boundary cut would be
  // nicer but adds variance to cache-key tokenization for marginal gain.
  return text.slice(0, max - 1) + "…";
}

// Render an exemplar list as a prompt-ready string. Returns "" when the
// list is empty so callers can concat unconditionally. Each exemplar is
// labelled with its source ("Saved + posted", "Posted", "Saved") plus the
// performance tag when present. Caption + hook get truncated to keep the
// total block size predictable across users with very long saves.
export function formatExemplarsForPrompt(exemplars) {
  if (!Array.isArray(exemplars) || exemplars.length === 0) return "";
  const labels = { both: "Saved + posted", result: "Posted", vault: "Saved" };
  const lines = exemplars.map((e, i) => {
    const platformBit = e.platform ? e.platform + (e.format ? " " + e.format : "") : (e.format || "");
    const sourceBit   = labels[e.source] || "Saved";
    const perfBit     = e.performanceTag === "well" ? ", performed well" : "";
    const header = (i + 1) + ". " + (platformBit ? platformBit + " — " : "") + sourceBit + perfBit;
    const body   = [];
    if (e.hook)        body.push("Hook: " + truncateForPrompt(e.hook, HOOK_MAX_CHARS));
    if (e.description) body.push("Caption: " + truncateForPrompt(e.description, CAPTION_MAX_CHARS));
    return header + "\n   " + body.join("\n   ");
  });
  return lines.join("\n\n");
}

// Pull the voice-bearing prose out of an exemplar list as one corpus.
// Used by voice-drift telemetry to enrich the reference text beyond
// sampleCaption + voiceSamples + handlePostExcerpts. Returns "" when the
// list is empty so the caller's existing "no reference → skip" path
// continues to work.
export function exemplarsAsVoiceText(exemplars) {
  if (!Array.isArray(exemplars) || exemplars.length === 0) return "";
  const parts = [];
  for (const e of exemplars) {
    if (e.hook)        parts.push(e.hook);
    if (e.description) parts.push(e.description);
  }
  return parts.join("\n\n");
}
