// Server-side helper to pull a user's recent plan history for week-over-week
// continuity. Returns the last N weeks of plans as a condensed shape the
// prompt builder can weave into context — strategy + a per-card summary
// (with logged-result metrics where available), not the full card payloads.
//
// Fail-open: missing table or fetch error returns an empty array, and the
// plan prompt falls back to single-week generation gracefully.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const SUPABASE_HEADERS = {
  apikey:        SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
};

async function fetchHistoryRows(userId, limit, currentWeekStart) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return [];
  try {
    let url = `${SUPABASE_URL}/rest/v1/plan_history`
      + `?user_id=eq.${userId}`
      + `&select=week_start,strategy,cards`
      + `&order=week_start.desc`
      + `&limit=${limit || 3}`;
    // Exclude the current week's row so a same-week regenerate doesn't
    // count as a prior week (which would otherwise bump the weekNumber in
    // the prompt and make the strategy talk about "week 2" when the user
    // is still regenerating "week 1"). The client owns the week_start key
    // when upserting plan_history (weekStartISO in index.html), so we use
    // the same value the client computed to avoid timezone drift between
    // the read filter and the write key.
    if (currentWeekStart) {
      url += `&week_start=lt.${encodeURIComponent(currentWeekStart)}`;
    }
    const res = await fetch(url, { headers: SUPABASE_HEADERS });
    if (!res.ok) return [];
    return await res.json();
  } catch (e) { return []; }
}

async function fetchUserResults(userId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${userId}&select=results`;
    const res = await fetch(url, { headers: SUPABASE_HEADERS });
    if (!res.ok) return [];
    const rows = await res.json();
    const results = (rows[0] && Array.isArray(rows[0].results)) ? rows[0].results : [];
    return results;
  } catch (e) { return []; }
}

// Score a logged result by views + likes*2 + saves*4. Saves > likes > views,
// roughly mirroring how platforms weight quality engagement.
function scoreResult(r) {
  if (!r || !r.result) return 0;
  const v = parseInt(r.result.views) || 0;
  const l = parseInt(r.result.likes) || 0;
  const s = parseInt(r.result.saves) || 0;
  return v + (l * 2) + (s * 4);
}

// Build a condensed "week summary" suitable for the prompt — only the
// signal the LLM needs to learn: strategy + per-card platform/format +
// result metrics on the cards that were actually logged.
function summarizeWeek(row, resultsByCardId) {
  const cards = Array.isArray(row.cards) ? row.cards : [];
  let topCard = null, topScore = -1;
  const condensed = cards.map(c => {
    if (!c) return null;
    const cardId = (c.title || "") + (c.day || "");
    const result = resultsByCardId[cardId] || null;
    const summary = {
      platform: c.platform || null,
      format:   c.format   || null,
      title:    c.title    || "",
      logged:   !!result,
    };
    if (result && result.result) {
      summary.views = result.result.views || null;
      summary.likes = result.result.likes || null;
      summary.saves = result.result.saves || null;
    }
    const score = scoreResult(result);
    if (score > topScore) { topScore = score; topCard = summary; }
    return summary;
  }).filter(Boolean);
  return {
    week_start:    row.week_start,
    strategy:      row.strategy || null,
    cards:         condensed,
    top_performer: topScore > 0 ? topCard : null,
    unlogged:      condensed.filter(c => !c.logged).length,
  };
}

// Main entry. Returns an array (most-recent-first) of week summaries.
// Empty when the user has no history (week 1) or when the table isn't
// provisioned yet. `currentWeekStart` (ISO YYYY-MM-DD of this week's
// Monday, computed by the client) is used to exclude the user's own
// in-progress week from the returned history — without it, a same-week
// regenerate would mis-count as week N+1.
export async function loadPlanHistoryForPrompt(userId, limit, currentWeekStart) {
  const [rows, results] = await Promise.all([
    fetchHistoryRows(userId, limit, currentWeekStart),
    fetchUserResults(userId),
  ]);
  if (!rows.length) return [];
  const resultsByCardId = {};
  for (const r of results) {
    if (r && r.id) resultsByCardId[r.id] = r;
  }
  return rows.map(r => summarizeWeek(r, resultsByCardId));
}
