// Server-side helper to load the most-recent trends row per platform.
// Used by api/chat.js to weave fresh items into plan / scan / caption
// prompts. Fail-open: a missing table or a Supabase blip returns {}, and
// the prompt builders skip trends injection without breaking the response.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Trends older than this stop being injected even if they're still the
// most recent row — stale "trends" do more harm than good.
const TREND_FRESHNESS_DAYS = 14;

export async function loadLatestTrends() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return {};
  try {
    // Pull recent rows then bucket client-side by platform → most recent
    // wins. Supabase doesn't expose a `distinct on (platform) order by
    // fetched_at desc` over REST cleanly, so this is the simplest approach
    // that doesn't require a custom view.
    const since = new Date(Date.now() - TREND_FRESHNESS_DAYS * 86400000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/trends`
      + `?select=platform,summary,items,sources,fetched_at`
      + `&fetched_at=gte.${encodeURIComponent(since)}`
      + `&order=fetched_at.desc`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    if (!res.ok) return {};
    const rows = await res.json();
    const byPlatform = {};
    for (const r of rows) {
      if (!r || !r.platform) continue;
      if (!byPlatform[r.platform]) byPlatform[r.platform] = r; // first hit wins (rows are desc-sorted)
    }
    return byPlatform;
  } catch (e) {
    return {};
  }
}
