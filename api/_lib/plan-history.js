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

// Earliest plan_history week_start for the user — the anchor for
// calendar-based week numbering. Returns null when the user has no
// history (or on any fetch error, fail-open like the rest of this file).
async function fetchEarliestWeekStart(userId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/plan_history`
      + `?user_id=eq.${userId}`
      + `&select=week_start`
      + `&order=week_start.asc`
      + `&limit=1`;
    const res = await fetch(url, { headers: SUPABASE_HEADERS });
    if (!res.ok) return null;
    const rows = await res.json();
    return (rows[0] && rows[0].week_start) || null;
  } catch (e) { return null; }
}

// UTC Monday of the week containing `d`, as YYYY-MM-DD. Server-side
// fallback for when the client didn't send currentWeekStart — mirrors
// the client's weekStartISO (index.html) closely enough for week math.
function weekStartUTC(d) {
  const date = new Date(d);
  const day = date.getUTCDay() || 7; // Sunday=7
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - (day - 1));
  return date.toISOString().slice(0, 10);
}

// Calendar-based week number: how many calendar weeks the current week
// sits after the user's first-ever plan week, plus one. Unlike counting
// history rows, this survives regenerates (one row per week regardless)
// and doesn't saturate at the fetch limit — a user in their 9th calendar
// week is week 9 even though the prompt only sees the last 3 summaries.
// Skipped weeks still advance the number, matching real elapsed time.
function calendarWeekNumber(earliestWeekStart, currentWeekStart) {
  if (!earliestWeekStart) return 1;
  const ref = currentWeekStart || weekStartUTC(Date.now());
  const diffMs = Date.parse(ref) - Date.parse(earliestWeekStart);
  if (!Number.isFinite(diffMs)) return 1;
  return Math.max(1, Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1);
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

// Main entry. Returns { weeks, weekNumber }:
//   weeks      — array (most-recent-first) of condensed week summaries,
//                empty when the user has no history or the table isn't
//                provisioned yet.
//   weekNumber — calendar-based: weeks elapsed since the user's first
//                plan week + 1. Computed from the earliest week_start,
//                NOT from weeks.length — the summaries are capped at
//                `limit` for prompt size, and counting them froze the
//                number at limit+1 ("week 4" forever once the user had
//                3+ weeks of history).
// `currentWeekStart` (ISO YYYY-MM-DD of this week's Monday, computed by
// the client) is used to exclude the user's own in-progress week from
// the returned summaries — without it, a same-week regenerate would
// mis-count as week N+1. The calendar week number is naturally immune
// to regenerates (one plan_history row per week regardless).
export async function loadPlanHistoryForPrompt(userId, limit, currentWeekStart) {
  const [rows, results, earliestWeekStart] = await Promise.all([
    fetchHistoryRows(userId, limit, currentWeekStart),
    fetchUserResults(userId),
    fetchEarliestWeekStart(userId),
  ]);
  const weekNumber = calendarWeekNumber(earliestWeekStart, currentWeekStart);
  if (!rows.length) return { weeks: [], weekNumber };
  const resultsByCardId = {};
  for (const r of results) {
    if (r && r.id) resultsByCardId[r.id] = r;
  }
  return { weeks: rows.map(r => summarizeWeek(r, resultsByCardId)), weekNumber };
}
