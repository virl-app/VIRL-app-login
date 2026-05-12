// Inline fresh-trends fetcher. Fans `researchTrends` out over a small set of
// platforms in parallel so plan / scan / caption generation can be backed by
// today's Perplexity signal instead of the cron-cached `trends` rows (which
// can be up to 7 days old).
//
// Shape parity: returns the same `{ [platform]: { summary, items, sources,
// fetched_at } }` map that loadLatestTrends() produces, so every downstream
// prompt builder (planTrendsContext / captionTrendsContext / scanTrendsContext)
// sees no change. Fail-open per platform: a single Perplexity miss reverts
// that platform to whatever the cached map has, never the whole call.
//
// Cost guardrails:
//   - Caller decides which platforms to fetch (plan: user's selected
//     platforms; caption: the single target platform; scan: user's profile
//     platforms, capped to MAX_INLINE_PLATFORMS).
//   - Concurrency limited so a 5-platform plan doesn't open 5 sockets to
//     Perplexity simultaneously and starve the function's runtime budget.

import { researchTrends } from "./trends-research.js";

// Hard cap. Scan is the only gen type that can legitimately want more than
// 2-3 platforms in one shot; even there, more than this and we're paying
// Perplexity for marginal signal the prompt mostly ignores.
export const MAX_INLINE_PLATFORMS = 4;

// Returns the shape loadLatestTrends() returns: { [platform]: row | undefined }.
// `cachedFallback` is the trends map already loaded from Supabase — used to
// fill gaps when Perplexity fails for a specific platform.
export async function fetchInlineTrends(platforms, cachedFallback) {
  const list = Array.isArray(platforms)
    ? platforms.filter(p => typeof p === "string" && p).slice(0, MAX_INLINE_PLATFORMS)
    : [];
  if (!list.length) return cachedFallback || {};

  const settled = await Promise.allSettled(list.map(p => researchTrends(p)));

  const out = Object.assign({}, cachedFallback || {});
  const nowIso = new Date().toISOString();
  for (let i = 0; i < list.length; i++) {
    const platform = list[i];
    const r = settled[i];
    if (r.status !== "fulfilled" || !r.value) {
      // Keep whatever the cached map had for this platform.
      continue;
    }
    out[platform] = {
      platform,
      summary:    r.value.summary || "",
      items:      Array.isArray(r.value.items)   ? r.value.items   : [],
      sources:    Array.isArray(r.value.sources) ? r.value.sources : [],
      fetched_at: nowIso,
    };
  }
  return out;
}

// Returns true iff `snapshot` is the shape we expect from fetchInlineTrends
// (or loadLatestTrends). Used by /api/chat to validate client-supplied
// regen snapshots before trusting them in the prompt builder.
export function isValidTrendsSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  for (const platform of Object.keys(snapshot)) {
    const row = snapshot[platform];
    if (!row || typeof row !== "object") return false;
    if (row.items !== undefined && !Array.isArray(row.items)) return false;
    if (row.sources !== undefined && !Array.isArray(row.sources)) return false;
  }
  return true;
}
