// Shared helper for admin endpoints: fetches auth.users (email +
// signup time) and public.profiles (creator name) in parallel, then
// returns a Map<userId, { name, email, signup_at }> the caller uses
// to enrich anonymous user_id columns into something glanceable.
//
// Both fetches fail-soft — if profiles is missing or auth admin is
// rate-limited the directory still returns whatever it could get,
// so the dashboard never goes blank when one side hiccups.

export async function fetchUserDirectory(SUPABASE_URL, SUPABASE_SERVICE_KEY) {
  const map = new Map();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return map;

  const [authRes, profRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000&page=1`, {
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY },
    }).catch(e => { console.error("[admin-users] auth fetch threw", e.message); return null; }),
    fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id,name&limit=2000`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    }).catch(e => { console.error("[admin-users] profiles fetch threw", e.message); return null; }),
  ]);

  let users = [];
  if (authRes && authRes.ok) {
    const body = await authRes.json().catch(() => ({}));
    users = Array.isArray(body) ? body : (body.users || []);
  } else if (authRes) {
    const text = await authRes.text().catch(() => "");
    console.error("[admin-users] auth fetch failed:", authRes.status, text);
  }

  const profileByUserId = {};
  if (profRes && profRes.ok) {
    const profiles = await profRes.json().catch(() => []);
    for (const p of profiles) if (p && p.id) profileByUserId[p.id] = p;
  } else if (profRes) {
    const text = await profRes.text().catch(() => "");
    console.error("[admin-users] profiles fetch failed:", profRes.status, text);
  }

  for (const u of users) {
    if (!u || !u.id) continue;
    map.set(u.id, {
      name:      (profileByUserId[u.id] && profileByUserId[u.id].name) || null,
      email:     u.email     || null,
      signup_at: u.created_at || null,
    });
  }

  return map;
}

// Convenience: best-effort label for a user. Prefers name, falls back
// to email's local-part, then "user-XXXX" from the id. Used by panels
// that have a single label slot per row.
export function userLabel(entry, userId) {
  if (entry && entry.name)  return entry.name;
  if (entry && entry.email) return entry.email.split("@")[0];
  return "user-" + (userId || "").slice(0, 6);
}
