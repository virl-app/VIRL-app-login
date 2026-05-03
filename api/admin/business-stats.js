// Phase 1 business dashboard aggregator. Sibling to usage-stats.js but
// focused on growth / activation / engagement / revenue mix instead of
// API spend. Pulls auth users, credits, events (60d), content_ratings,
// rolls them up, and returns one JSON blob. Bearer-token gated to the
// admin email — same pattern as usage-stats.js.
//
// All aggregation happens in JS so the shape can iterate without
// schema migrations.

const ADMIN_EMAIL          = "laurenannedoty@gmail.com";
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const FOUNDING_CAP   = 100;
const STANDARD_PRICE = 25;
const FOUNDING_PRICE = 25; // founding rate matches standard for now
const DAY_MS         = 86400000;

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

// Supabase admin users endpoint paginates; for early-stage volume one page
// at per_page=1000 covers everything. If we cross 1000, this becomes a loop.
async function fetchAuthUsers() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000&page=1`, {
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY },
  });
  if (!r.ok) throw new Error("auth users fetch " + r.status);
  const body = await r.json();
  // Newer gotrue responses wrap the list in { users: [...] }; older versions
  // return the array directly. Handle both.
  return Array.isArray(body) ? body : (body.users || []);
}

async function fetchCredits() {
  // Don't reference updated_at — column isn't on the table and the request
  // 400s. If we later want a churn-by-date metric, that needs a migration
  // adding a plan_changed_at column the stripe webhook can stamp.
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/credits?select=user_id,plan,credits,stripe_customer_id&limit=2000`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    console.error("[business-stats] credits fetch failed:", r.status, text);
    throw new Error("credits fetch " + r.status);
  }
  return await r.json();
}

async function fetchEvents(sinceIso) {
  const url = `${SUPABASE_URL}/rest/v1/events`
    + `?select=user_id,event_name,properties,created_at`
    + `&created_at=gte.${encodeURIComponent(sinceIso)}`
    + `&order=created_at.desc&limit=20000`;
  const r = await fetch(url, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error("events fetch " + r.status);
  return await r.json();
}

async function fetchRatings() {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/content_ratings?select=generation_type,rating,created_at&limit=20000`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  // Table is brand-new — if the migration hasn't been applied yet just
  // return an empty list rather than 500ing the whole dashboard.
  if (!r.ok) return [];
  return await r.json();
}

async function fetchProfiles() {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?select=id,name&limit=2000`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  if (!r.ok) return [];
  return await r.json();
}

// ── Aggregators ─────────────────────────────────────────────────────────────

function dayKey(d) { return d.toISOString().slice(0, 10); }

function signupsDaily(users, days) {
  const today = new Date();
  today.setUTCHours(0,0,0,0);
  const buckets = [];
  const idx = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * DAY_MS);
    const k = dayKey(d);
    idx[k] = buckets.length;
    buckets.push({ date: k, count: 0 });
  }
  for (const u of users) {
    if (!u.created_at) continue;
    const k = u.created_at.slice(0, 10);
    if (idx[k] !== undefined) buckets[idx[k]].count++;
  }
  return buckets;
}

// Activation = % of signups in the window who triggered at least one
// plan_generated event. Time-to-first-plan = ms between signup and first
// plan event for that user. We compute a median (more robust than mean
// when one user's onboarding takes a week).
function activation(users, events, days) {
  const cutoff = Date.now() - days * DAY_MS;
  const recentSignups = users.filter(u => u.created_at && Date.parse(u.created_at) >= cutoff);
  const planEvents = events.filter(e => e.event_name === "plan_generated");
  const firstPlanByUser = {};
  for (const e of planEvents) {
    if (!e.user_id || !e.created_at) continue;
    const t = Date.parse(e.created_at);
    if (!firstPlanByUser[e.user_id] || t < firstPlanByUser[e.user_id]) {
      firstPlanByUser[e.user_id] = t;
    }
  }
  const activated = [];
  for (const u of recentSignups) {
    const fp = firstPlanByUser[u.id];
    if (fp && fp >= Date.parse(u.created_at)) {
      activated.push(fp - Date.parse(u.created_at));
    }
  }
  activated.sort((a, b) => a - b);
  const med = activated.length
    ? activated[Math.floor(activated.length / 2)]
    : null;
  return {
    signups:   recentSignups.length,
    activated: activated.length,
    rate:      recentSignups.length ? activated.length / recentSignups.length : 0,
    median_time_to_first_plan_hours: med !== null ? +(med / 3600000).toFixed(1) : null,
  };
}

// Active = generated, rated, scanned, etc. — anything that lands in events.
function activeUsers(events) {
  const now = Date.now();
  const dau = new Set(), wau = new Set(), mau = new Set();
  for (const e of events) {
    if (!e.user_id || !e.created_at) continue;
    const t = Date.parse(e.created_at);
    if (now - t < 1  * DAY_MS) dau.add(e.user_id);
    if (now - t < 7  * DAY_MS) wau.add(e.user_id);
    if (now - t < 30 * DAY_MS) mau.add(e.user_id);
  }
  return {
    dau: dau.size,
    wau: wau.size,
    mau: mau.size,
    stickiness: mau.size ? +(dau.size / mau.size).toFixed(2) : 0,
  };
}

function ratingsByType(rows) {
  const out = {};
  for (const r of rows) {
    const t = r.generation_type || "(unknown)";
    if (!out[t]) out[t] = { up: 0, down: 0 };
    if (r.rating === "up")   out[t].up++;
    if (r.rating === "down") out[t].down++;
  }
  for (const t of Object.keys(out)) {
    const tot = out[t].up + out[t].down;
    out[t].total = tot;
    out[t].up_rate = tot ? +(out[t].up / tot).toFixed(2) : 0;
  }
  return out;
}

function planMix(credits) {
  const counts = { free: 0, founding: 0, standard: 0, pro: 0, cancelled: 0, past_due: 0, other: 0 };
  for (const c of credits) {
    const p = (c.plan || "free").toLowerCase();
    if (counts[p] !== undefined) counts[p]++; else counts.other++;
  }
  const paidActive = counts.founding + counts.standard + counts.pro;
  const mrr = (counts.founding * FOUNDING_PRICE) + (counts.standard * STANDARD_PRICE) + (counts.pro * STANDARD_PRICE);
  return Object.assign({}, counts, {
    paid_active:               paidActive,
    mrr_usd:                   mrr,
    founding_slots_remaining:  Math.max(0, FOUNDING_CAP - counts.founding),
    founding_cap:              FOUNDING_CAP,
  });
}

// Lifetime cancelled / past-due. We can't filter to "this month" without
// a plan_changed_at column on credits — the webhook doesn't stamp one
// today. Once that migration lands, swap this back to a date-windowed
// count. For now, lifetime is still useful — paired with the active
// counts in plan_mix you can eyeball net churn.
function churnLifetime(credits) {
  let cancelled = 0, pastDue = 0;
  for (const c of credits) {
    if (c.plan === "cancelled") cancelled++;
    else if (c.plan === "past_due") pastDue++;
  }
  return { cancelled, past_due: pastDue };
}

// Most-recent signups for the admin's "Who just joined?" panel. Joined
// against the profiles table so we can show real names alongside the
// email — both fall back gracefully if missing.
function recentSignups(users, profilesById, n) {
  return users
    .filter(u => u && u.id && u.created_at)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, n)
    .map(u => {
      const md  = u.user_metadata || {};
      const prf = profilesById[u.id] || {};
      return {
        user_id:    u.id,
        name:       prf.name || null,
        email:      u.email   || null,
        signup_at:  u.created_at,
        utm_source: md.utm_source || md.ref || null,
      };
    });
}

// Pull utm_source / referrer from user_metadata (we stamp it at signup).
// Group + count, top N.
function signupSources(users, n) {
  const map = {};
  for (const u of users) {
    const md = (u.user_metadata || {});
    let src = (md.utm_source || md.ref || "").trim();
    if (!src && md.referrer) {
      try {
        const host = new URL(md.referrer).host;
        src = host || "(direct)";
      } catch (e) { src = "(direct)"; }
    }
    src = (src || "(direct)").toLowerCase().slice(0, 60);
    map[src] = (map[src] || 0) + 1;
  }
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([source, count]) => ({ source, count }));
}

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const ok = await verifyAdmin(auth);
  if (!ok) return res.status(403).json({ error: "Not authorized" });

  let users, credits, events, ratings, profiles;
  try {
    const since60 = new Date(Date.now() - 60 * DAY_MS).toISOString();
    [users, credits, events, ratings, profiles] = await Promise.all([
      fetchAuthUsers(),
      fetchCredits(),
      fetchEvents(since60),
      fetchRatings(),
      fetchProfiles(),
    ]);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const profilesById = {};
  for (const p of profiles) if (p && p.id) profilesById[p.id] = p;

  return res.status(200).json({
    totals: {
      users:       users.length,
      events_60d:  events.length,
      ratings_all: ratings.length,
    },
    signups_daily_30d:  signupsDaily(users, 30),
    activation_30d:     activation(users, events, 30),
    active_users:       activeUsers(events),
    ratings_by_type:    ratingsByType(ratings),
    plan_mix:           planMix(credits),
    churn_lifetime:     churnLifetime(credits),
    top_signup_sources: signupSources(users, 8),
    recent_signups:     recentSignups(users, profilesById, 10),
  });
}
