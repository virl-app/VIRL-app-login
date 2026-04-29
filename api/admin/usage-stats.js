// Admin-only aggregator for the cost/usage Dashboard panel. Pulls the last
// 30 days of usage_events and returns rolled-up stats: 7-day / 30-day
// totals, per-generation-type breakdown, per-model split, daily sparkline,
// and top 10 users by spend. Bearer-token gated to the admin email.
//
// Aggregation happens in JS rather than via SQL views so we can iterate on
// the shape without schema migrations.

const ADMIN_EMAIL          = "laurenannedoty@gmail.com";
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const DAY_MS = 86400000;

async function verifyAdmin(token) {
  if (!token || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.email && u.email.toLowerCase() === ADMIN_EMAIL.toLowerCase());
  } catch (e) { return false; }
}

async function fetchEvents(since) {
  // Supabase REST caps single requests at 1000 rows by default. At launch
  // scale we won't approach that for 30 days; if we do, this becomes a
  // paginated loop.
  const url = `${SUPABASE_URL}/rest/v1/usage_events`
    + `?select=user_id,generation_type,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,est_cost_usd,created_at`
    + `&created_at=gte.${encodeURIComponent(since)}`
    + `&order=created_at.desc`
    + `&limit=10000`;
  const r = await fetch(url, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error("usage_events fetch " + r.status);
  return await r.json();
}

function rollUp(events) {
  let totalCost = 0, totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
  for (const e of events) {
    totalCost       += parseFloat(e.est_cost_usd) || 0;
    totalInput      += e.input_tokens             || 0;
    totalOutput     += e.output_tokens            || 0;
    totalCacheRead  += e.cache_read_tokens        || 0;
    totalCacheWrite += e.cache_write_tokens       || 0;
  }
  // Cache hit rate = how much of "would-have-been-input" was cached.
  // (cache_read) / (cache_read + non-cached input). Excludes output.
  const denom = totalCacheRead + totalInput;
  const cacheHitRate = denom > 0 ? totalCacheRead / denom : 0;
  return {
    count:            events.length,
    cost:             totalCost,
    input_tokens:     totalInput,
    output_tokens:    totalOutput,
    cache_read:       totalCacheRead,
    cache_write:      totalCacheWrite,
    cache_hit_rate:   cacheHitRate,
  };
}

function groupBy(events, key) {
  const map = {};
  for (const e of events) {
    const k = e[key] || "(unknown)";
    if (!map[k]) map[k] = [];
    map[k].push(e);
  }
  const out = {};
  for (const k of Object.keys(map)) out[k] = rollUp(map[k]);
  return out;
}

function dailySparkline(events, days) {
  const today = new Date();
  today.setUTCHours(0,0,0,0);
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * DAY_MS);
    buckets.push({ date: d.toISOString().slice(0, 10), cost: 0, count: 0 });
  }
  const idxByDate = {};
  buckets.forEach((b, i) => { idxByDate[b.date] = i; });
  for (const e of events) {
    if (!e.created_at) continue;
    const d = e.created_at.slice(0, 10);
    const i = idxByDate[d];
    if (i === undefined) continue;
    buckets[i].cost += parseFloat(e.est_cost_usd) || 0;
    buckets[i].count++;
  }
  return buckets;
}

function topUsers(events, n) {
  const byUser = {};
  for (const e of events) {
    const id = e.user_id;
    if (!id) continue;
    if (!byUser[id]) byUser[id] = { user_id: id, cost: 0, count: 0 };
    byUser[id].cost  += parseFloat(e.est_cost_usd) || 0;
    byUser[id].count++;
  }
  return Object.values(byUser)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, n);
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const ok = await verifyAdmin(auth);
  if (!ok) return res.status(403).json({ error: "Not authorized" });

  const since30 = new Date(Date.now() - 30 * DAY_MS).toISOString();
  let events;
  try { events = await fetchEvents(since30); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  // Filter for last-7d window using the same dataset (no second round-trip).
  const since7 = Date.now() - 7 * DAY_MS;
  const events7 = events.filter(e => Date.parse(e.created_at) >= since7);

  return res.status(200).json({
    last_7d:           rollUp(events7),
    last_30d:          rollUp(events),
    by_generation_type: groupBy(events, "generation_type"),
    by_model:          groupBy(events, "model"),
    daily_sparkline:   dailySparkline(events, 14),
    top_users:         topUsers(events, 10),
  });
}
