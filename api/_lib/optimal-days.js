// /api/_lib/optimal-days.js
// ─────────────────────────────────────────────────────────────────────────────
// [POSTFREQ-OPTIMAL] Computes per-platform "best days of the week to post"
// from the creator's own logged engagement history, with fallback to
// general platform-rule-of-thumb when no history exists.
//
// Used by the plan prompt builder so when a user says "post a few times a
// week," VIRL picks the days the user's audience actually shows up — not
// random ones.
//
// Data sources:
//   - user_data.vault   — each plan card the creator saved (has `day` field
//                          like "Day 4 - Thursday" → weekday extraction).
//   - user_data.results — each logged engagement row (has `id`, joined to
//                          vault to recover the day).
//
// Engagement score: same shape used elsewhere (views + likes×2 + saves×4),
// matching how platforms weight quality. A high-engagement vault item on
// Thursday is signal that Thursday works for THIS creator.
//
// Fallback: when a user has fewer than MIN_RESULTS_PER_PLATFORM logged
// posts on a given platform (signal too thin to be meaningful), we surface
// the platform's general best-day guidance instead. This keeps the prompt
// useful from day one without misleading "your best day is X" claims
// based on n=1.
// ─────────────────────────────────────────────────────────────────────────────

// Minimum logged results on a platform before we treat the user's
// historical pattern as signal. Below this we fall back to general
// platform guidance. Three logged posts is the smallest n where "best
// day" doesn't read as superstition.
const MIN_RESULTS_PER_PLATFORM = 3;

// Minimum count on a specific weekday before that weekday qualifies as a
// "best day." Without this, a single high-performing post on a Tuesday
// would crown Tuesday for that user.
const MIN_RESULTS_PER_WEEKDAY = 2;

// How many top weekdays to surface per platform. Three gives the plan
// generator enough room to spread posts; more starts to feel like "every
// day works."
const TOP_DAYS_PER_PLATFORM = 3;

// General per-platform best-days guidance (used when the user has no
// signal yet). Same source rationale as PLATFORM_TIMING_TIPS in
// index.html — industry rule-of-thumb that's directionally right
// without being prescriptive. Phrased as ordered "best day" arrays
// (most preferred first).
const PLATFORM_GENERAL_BEST_DAYS = {
  TikTok:    ["Tuesday", "Thursday", "Friday"],
  Instagram: ["Wednesday", "Friday", "Saturday"],
  LinkedIn:  ["Tuesday", "Wednesday", "Thursday"],
  YouTube:   ["Thursday", "Friday", "Saturday"],
  X:         ["Tuesday", "Wednesday", "Thursday"],
  Pinterest: ["Saturday", "Sunday", "Monday"],
  Facebook:  ["Wednesday", "Thursday", "Friday"],
};

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
  return (pick(result.views) || 0) + (pick(result.likes) * 2) + (pick(result.saves) * 4);
}

// Pull weekday from a day field like "Day 4 - Thursday" or a vault item's
// stored day. Returns canonical capitalized weekday name, or null when
// the format doesn't match.
const WEEKDAY_PATTERN = /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/i;
function extractWeekday(dayStr) {
  if (typeof dayStr !== "string") return null;
  const m = dayStr.match(WEEKDAY_PATTERN);
  if (!m) return null;
  const wd = m[1].toLowerCase();
  return wd.charAt(0).toUpperCase() + wd.slice(1);
}

// Public entry. Returns a map keyed by platform → ordered array of best
// weekday names (most preferred first). When the user has signal,
// surfaces THEIR historical pattern; otherwise falls back to general
// platform guidance for the platforms they've selected (or for all
// known platforms when no platform list passed).
//
// Args:
//   vault             — user_data.vault array (each entry may have
//                        platform + day + id)
//   results           — user_data.results array (each entry has
//                        platform + id + result {views, likes, saves})
//   targetPlatforms?  — array of platform names the caller cares about.
//                        When provided, only those keys appear in the
//                        output. When omitted, every platform with
//                        general fallback data is included.
export function computeOptimalDays(vault, results, targetPlatforms) {
  const safeVault   = Array.isArray(vault)   ? vault   : [];
  const safeResults = Array.isArray(results) ? results : [];

  // Index vault items by id so a results row can recover the day field.
  const vaultById = {};
  for (const v of safeVault) {
    if (v && v.id != null) vaultById[v.id] = v;
  }

  // For each result with a matching vault entry, derive the weekday and
  // accumulate engagement totals + counts per (platform, weekday).
  // Shape: platformScores[platform][weekday] = { score, count }
  const platformScores = {};
  const platformResultCount = {};
  for (const r of safeResults) {
    if (!r || r.id == null) continue;
    const platform = r.platform || (vaultById[r.id] && vaultById[r.id].platform);
    if (!platform) continue;
    const vaultMatch = vaultById[r.id];
    const dayStr     = (vaultMatch && vaultMatch.day) || r.day || null;
    const weekday    = extractWeekday(dayStr);
    if (!weekday) continue;
    const score = engagementScore(r.result);
    if (score <= 0) continue;
    if (!platformScores[platform]) platformScores[platform] = {};
    if (!platformScores[platform][weekday]) platformScores[platform][weekday] = { score: 0, count: 0 };
    platformScores[platform][weekday].score += score;
    platformScores[platform][weekday].count += 1;
    platformResultCount[platform] = (platformResultCount[platform] || 0) + 1;
  }

  // Build the platform list we'll return. Either the caller's targets,
  // or every platform with general fallback data.
  const platformsOut = Array.isArray(targetPlatforms) && targetPlatforms.length
    ? targetPlatforms.filter(p => typeof p === "string" && p)
    : Object.keys(PLATFORM_GENERAL_BEST_DAYS);

  const out = {};
  for (const platform of platformsOut) {
    const userResultCount = platformResultCount[platform] || 0;
    const scores          = platformScores[platform] || {};
    if (userResultCount >= MIN_RESULTS_PER_PLATFORM) {
      // Enough signal — rank weekdays by average engagement, keeping
      // only those with the minimum-per-weekday count. Ties break by
      // raw total score (the larger sample wins).
      const ranked = Object.keys(scores)
        .filter(wd => scores[wd].count >= MIN_RESULTS_PER_WEEKDAY)
        .map(wd => ({
          weekday: wd,
          avg:     scores[wd].score / scores[wd].count,
          total:   scores[wd].score,
        }))
        .sort((a, b) => b.avg !== a.avg ? (b.avg - a.avg) : (b.total - a.total));
      if (ranked.length) {
        out[platform] = {
          source: "user_history",
          days:   ranked.slice(0, TOP_DAYS_PER_PLATFORM).map(r => r.weekday),
        };
        continue;
      }
    }
    // Fall back to general platform best-days.
    out[platform] = {
      source: "general",
      days:   (PLATFORM_GENERAL_BEST_DAYS[platform] || []).slice(0, TOP_DAYS_PER_PLATFORM),
    };
  }

  return out;
}

// Render the optimal-days map as a prompt-ready string. Returns "" when
// the map is empty so callers can concat unconditionally. Source labels
// help the model weight the recommendation appropriately ("user_history"
// is a stronger nudge than "general").
export function formatOptimalDaysForPrompt(optimalDays) {
  if (!optimalDays || typeof optimalDays !== "object") return "";
  const entries = Object.keys(optimalDays);
  if (!entries.length) return "";
  const lines = entries.map(platform => {
    const v = optimalDays[platform];
    if (!v || !Array.isArray(v.days) || !v.days.length) return null;
    const label = v.source === "user_history"
      ? "performs best on"
      : "general best days (no logged signal yet)";
    return "  - " + platform + " — " + label + ": " + v.days.join(", ");
  }).filter(Boolean);
  if (!lines.length) return "";
  return "OPTIMAL DAYS PER PLATFORM (lean toward these when distributing cards across the week):\n"
    + lines.join("\n");
}
