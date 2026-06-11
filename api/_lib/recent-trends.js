// [TRENDS-VARIETY] Pulls the trend strings VIRL has surfaced to this user
// in their last few plans, so the inline trends Perplexity call can ask
// for genuinely new signal instead of resurfacing the same items.
//
// Source of truth: each plan card in plan_history may have a `trend` field
// the model populated when it wove a current trend into the card. We walk
// the most recent N weeks of plans and collect distinct trend descriptions.
//
// Fail-open: any error returns an empty array; the trends prompt then
// behaves identically to the pre-dedup version (no "avoid these" block).

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const SUPABASE_HEADERS = {
  apikey:        SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
};

// Cap on how many recent weeks of history to scan. Three is enough to
// cover "this isn't a fluke, you've been pushing this trend for a while"
// without bloating the Perplexity prompt with stale items.
const MAX_HISTORY_WEEKS = 3;

// Cap on how many distinct trend strings to return. The prompt-side
// formatter shows them as a bullet list; more than ~12 starts to feel
// like noise to the model and crowds out actual instructions.
const MAX_TRENDS = 12;

// Returns an array of trend description strings the user has seen in
// their last MAX_HISTORY_WEEKS plans, de-duplicated and trimmed. Most-
// recent-first (so the more salient items appear earlier in the prompt's
// "already seen" list).
export async function fetchRecentTrendStrings(userId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !userId) return [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/plan_history`
      + `?user_id=eq.${userId}`
      + `&select=cards,week_start`
      + `&order=week_start.desc`
      + `&limit=${MAX_HISTORY_WEEKS}`;
    const res = await fetch(url, { headers: SUPABASE_HEADERS });
    if (!res.ok) return [];
    const rows = await res.json();
    const seen = {};
    const out  = [];
    for (const row of rows) {
      if (!row || !Array.isArray(row.cards)) continue;
      for (const card of row.cards) {
        if (!card) continue;
        const t = card.trend;
        if (typeof t !== "string") continue;
        const trimmed = t.trim();
        if (!trimmed) continue;
        // Dedup on a normalized form so casing / trailing-period
        // variations don't get counted as distinct.
        const key = trimmed.toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
        if (seen[key]) continue;
        seen[key] = true;
        out.push(trimmed);
        if (out.length >= MAX_TRENDS) return out;
      }
    }
    return out;
  } catch (e) { return []; }
}
