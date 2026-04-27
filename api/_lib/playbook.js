// Loads the platform playbook (one row per platform, normalized fields)
// from Supabase and exposes it to the prompt builders. The playbook is the
// single source of truth for cadence / peak times / hook windows / hashtag
// counts / format priority / top engagement signals — both rendered to the
// user on the Algo tab and woven into every Anthropic prompt.
//
// Fail-open: if the table is missing or the fetch errors, we return an
// empty map and the prompts skip the playbook injection (still produce
// output, just without the platform grounding).

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export async function loadPlaybook() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return {};
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/playbook?select=*`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) return {};
    const rows = await res.json();
    const byPlatform = {};
    for (const r of rows) {
      if (r && r.platform) byPlatform[r.platform] = r;
    }
    return byPlatform;
  } catch (e) {
    return {};
  }
}
