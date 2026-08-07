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

// [PLAYBOOK-AGE] How long a playbook row may go unverified before the prompts
// stop calling it authoritative.
//
// 90 days, because the refresh cron runs MONTHLY: a healthy pipeline restates
// every row roughly every 30 days, so 90 is three consecutive missed cycles.
// That is past the point where any single explanation (a quiet research month,
// one failed run, an admin who hasn't clicked Approve) still covers it — and
// it is short enough to catch a platform mechanic that actually moved. Below
// this, an occasional gap is normal operation and warning about it would train
// the reader to ignore the warning.
//
// The rows themselves get `updated_at` on every admin approval
// (api/admin/playbook-draft-review.js) — until this constant existed, nothing
// anywhere read it, so a two-year-old row was framed to the model in exactly
// the same words as one verified yesterday.
export const PLAYBOOK_STALE_DAYS = 90;

const DAY_MS = 86400000;

function entryUpdatedAt(entry) {
  if (!entry || !entry.updated_at) return null;
  const t = Date.parse(entry.updated_at);
  return Number.isNaN(t) ? null : t;
}

// Age of the playbook slice a given surface is about to quote, measured from
// its OLDEST entry — a plan spanning five platforms is only as current as the
// least-recently-verified one, and the creator reads all five as equally live.
//
// `known: false` means no entry carried a parseable `updated_at` (pre-column
// rows, or an empty playbook). That is deliberately NOT treated as stale:
// missing data is not negative data, and downgrading every prompt on a schema
// gap would be a worse failure than the one this guards against. Callers fall
// back to neutral framing instead — no authority claim, no staleness warning.
export function playbookAge(playbook, platforms, nowMs) {
  const now = (typeof nowMs === "number") ? nowMs : Date.now();
  const keys = (Array.isArray(platforms) && platforms.length)
    ? platforms
    : Object.keys(playbook || {});
  let oldest = null;
  for (const p of keys) {
    const t = entryUpdatedAt(playbook && playbook[p]);
    if (t == null) continue;
    if (oldest == null || t < oldest) oldest = t;
  }
  if (oldest == null) return { known: false, days: null, date: null, stale: false };
  const days = Math.max(0, Math.floor((now - oldest) / DAY_MS));
  return {
    known: true,
    days,
    date:  new Date(oldest).toISOString().slice(0, 10),
    stale: days >= PLAYBOOK_STALE_DAYS,
  };
}

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
