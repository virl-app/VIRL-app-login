// /api/_lib/performance-insights.js
// ─────────────────────────────────────────────────────────────────────────────
// [PROVEN-FOR-YOU] Derives "what content is actually working" for a creator
// from their OWN logged post performance, and renders it as a compact prompt
// block. This is the content-strategy half of the results→generation loop:
// optimal-days.js already feeds logged results back as *timing* signal (best
// weekday per platform); this feeds them back as *content* signal (which
// formats and platforms earn the most engagement for THIS creator).
//
// Data sources (identical to optimal-days.js — same user_data row, no extra
// query): user_data.vault (saved plan cards; each has `format` + `platform`)
// joined to user_data.results (logged engagement rows referencing a vault id
// and carrying a `result` {views, likes, saves}).
//
// Engagement score mirrors the rest of the codebase: views + likes×2 + saves×4
// (saves are the strongest intent signal, so they weigh most).
//
// Honesty gates: nothing is surfaced until there's enough signal to be real,
// not superstition — MIN_TOTAL_RESULTS logged posts overall, and per
// format/platform a minimum count before it can be named a "top" performer.
// Below threshold the formatter returns "" so the prompt simply omits the
// block (and the model never sees a fabricated "your best format is X" from
// n=1). Gated at the call site behind the creator's learn_from_results opt-in.
// ─────────────────────────────────────────────────────────────────────────────

// Minimum logged results overall before we surface any performance insight.
const MIN_TOTAL_RESULTS  = 3;
// Minimum logged posts on a single format/platform before it can be crowned.
const MIN_PER_FORMAT     = 2;
const MIN_PER_PLATFORM   = 2;

// Parse a metric that may arrive as a number or a human string ("1.2k", "3,400").
function toNumber(v) {
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
}

function engagementScore(result) {
  if (!result || typeof result !== "object") return 0;
  return toNumber(result.views) + toNumber(result.likes) * 2 + toNumber(result.saves) * 4;
}

// Rank a { key: {score, count} } accumulator by average engagement, keeping
// only keys that clear the minimum-count bar. Returns [{ name, avg, count }].
function rankByAvg(acc, minCount) {
  return Object.keys(acc)
    .filter(k => acc[k].count >= minCount)
    .map(k => ({ name: k, avg: acc[k].score / acc[k].count, count: acc[k].count }))
    .sort((a, b) => b.avg - a.avg);
}

// Public entry. Returns a structured insight object, or null when signal is
// too thin to say anything honest.
//
// Shape: {
//   totalLogged:   number,
//   topFormat:     { name, avg, count, multiple } | null,  // multiple = avg vs. the rest
//   topPlatform:   { name, avg, count } | null,
// }
export function computePerformanceInsights(vault, results) {
  const safeVault   = Array.isArray(vault)   ? vault   : [];
  const safeResults = Array.isArray(results) ? results : [];

  const vaultById = {};
  for (const v of safeVault) if (v && v.id != null) vaultById[v.id] = v;

  const byFormat   = {};
  const byPlatform = {};
  let totalLogged = 0;

  for (const r of safeResults) {
    if (!r || r.id == null) continue;
    const score = engagementScore(r.result);
    if (score <= 0) continue;                 // unlogged / zeroed rows carry no signal
    const match    = vaultById[r.id];
    const format   = (match && match.format)   || null;
    const platform = r.platform || (match && match.platform) || null;

    totalLogged += 1;
    if (format) {
      if (!byFormat[format]) byFormat[format] = { score: 0, count: 0 };
      byFormat[format].score += score;
      byFormat[format].count += 1;
    }
    if (platform) {
      if (!byPlatform[platform]) byPlatform[platform] = { score: 0, count: 0 };
      byPlatform[platform].score += score;
      byPlatform[platform].count += 1;
    }
  }

  if (totalLogged < MIN_TOTAL_RESULTS) return null;

  const rankedFormats   = rankByAvg(byFormat,   MIN_PER_FORMAT);
  const rankedPlatforms = rankByAvg(byPlatform, MIN_PER_PLATFORM);

  let topFormat = null;
  if (rankedFormats.length) {
    const winner = rankedFormats[0];
    // How much better is the top format than everything else logged? Only
    // computed when there's a "rest" to compare against, so a single-format
    // creator gets a plain "best-performing" statement instead of a fake ratio.
    const rest = Object.keys(byFormat).filter(k => k !== winner.name);
    let multiple = null;
    if (rest.length) {
      let restScore = 0, restCount = 0;
      for (const k of rest) { restScore += byFormat[k].score; restCount += byFormat[k].count; }
      const restAvg = restCount ? restScore / restCount : 0;
      if (restAvg > 0) multiple = winner.avg / restAvg;
    }
    topFormat = { name: winner.name, avg: winner.avg, count: winner.count, multiple };
  }

  const topPlatform = rankedPlatforms.length
    ? { name: rankedPlatforms[0].name, avg: rankedPlatforms[0].avg, count: rankedPlatforms[0].count }
    : null;

  if (!topFormat && !topPlatform) return null;  // nothing cleared the per-bucket bar
  return { totalLogged, topFormat, topPlatform };
}

// Render the insight as a prompt-ready block. Returns "" when the insight is
// null/empty so callers can concatenate unconditionally.
export function formatPerformanceForPrompt(insights) {
  if (!insights || typeof insights !== "object") return "";
  const lines = [];

  if (insights.topFormat) {
    const f = insights.topFormat;
    if (f.multiple && f.multiple >= 1.3) {
      lines.push(
        "  - Top-performing format: " + f.name + " — about "
        + f.multiple.toFixed(1) + "× the engagement of their other formats (across "
        + f.count + " logged post" + (f.count === 1 ? "" : "s") + ")."
      );
    } else {
      lines.push(
        "  - Best-performing format: " + f.name
        + " (across " + f.count + " logged post" + (f.count === 1 ? "" : "s") + ")."
      );
    }
  }
  if (insights.topPlatform) {
    lines.push(
      "  - Strongest platform by engagement: " + insights.topPlatform.name
      + " (" + insights.topPlatform.count + " logged post"
      + (insights.topPlatform.count === 1 ? "" : "s") + ")."
    );
  }
  if (!lines.length) return "";

  return "PROVEN FOR YOU — patterns from the creator's OWN logged post performance "
    + "(engagement weights saves and likes over views, matching what real audiences reward). "
    + "These reflect what this specific creator's audience actually responds to, so weight them "
    + "heavily when they fit the request:\n"
    + lines.join("\n")
    + "\nFavor these where they suit the creator's goals and this ask — but never force them when "
    + "the request clearly calls for a different format or platform.";
}
