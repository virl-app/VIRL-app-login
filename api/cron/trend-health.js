// [TREND-HEALTH] Daily staleness check on both trend pipelines.
//
// Why this exists: on 2026-07-30 the observed trend ingest stopped writing and
// nobody found out for eight days. The edge function behaved exactly as
// designed — an empty adapter result takes the fail-soft branch, logs "check
// adapter health", writes nothing, and returns a healthy 200 so a transient
// vendor blip can't cascade every trend to `dead`. That is the right call for
// one bad run and the wrong outcome for eight in a row, because nothing
// escalates. Same shape as the playbook refresh alerting only on success: the
// failure was observable in a log line and invisible everywhere a human looks.
//
// WHY A STALENESS MONITOR RATHER THAN AN ALERT INSIDE THE INGEST FUNCTION:
// an in-function alert can only fire on a run that happens. It cannot detect
// the pg_cron schedule being dropped, the edge function failing to deploy, the
// Supabase project being paused, or the secret being rotated so the invocation
// 401s before any of our code runs — and any of those produces the identical
// symptom. Checking the AGE OF THE DATA catches every one of them, including
// the empty-run case, because they all end the same way: `last_seen` stops
// moving. Monitor the outcome, not the mechanism.
//
// Auth: same CRON_SECRET pattern as the other crons.

import { sendEmail }          from "../_lib/email-send.js";
import { trendPipelineStale } from "../_lib/email-templates.js";
import { cronAuthorized }     from "../_lib/cron-auth.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_EMAIL          = "laurenannedoty@gmail.com";

const DAY_MS = 86400000;

// [TREND-HEALTH] The platforms VIRL supports, mirroring the PLATFORMS array in
// cron/trends-refresh.js. Kept as its own list because this file asks a
// different question of it — not "which platforms do we research?" but "which
// platforms must have current research for a creator on them to be served?"
const PLATFORMS = ["TikTok", "Instagram", "Facebook", "YouTube", "LinkedIn", "X", "Pinterest"];

// [TREND-HEALTH] Thresholds are set to warn BEFORE the data stops being
// usable, which is the whole point of catching this early.
//
//   Observed pipeline: ingested Mon + Thu, so the widest healthy gap is ~4
//   days. Generation refuses any trend older than 7 days
//   (TREND_FRESHNESS_DAYS in trend-context.js). Alerting at 5 lands in
//   between: one missed cycle is normal and silent, two is a real signal, and
//   the warning arrives with ~2 days of runway before creators go trend-dark.
//   Raising this above 7 would mean the email only ever arrives to tell you
//   about an outage that already reached your users.
//
//   Legacy research: refreshed weekly, and it is now the fallback the prompts
//   fall back TO, so its own staleness matters. 10 days = one missed weekly
//   run plus slack, and it stays under the 14-day window the fallback query
//   uses — past 14 the fallback returns nothing and every surface goes dark.
const OBSERVED_STALE_DAYS = 5;
const LEGACY_STALE_DAYS   = 10;

const SUPABASE_HEADERS = {
  apikey:        SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
};

// Newest timestamp in a table, or null when the table is empty / unreachable.
// Best-effort by design: a failed probe must not fail the whole check, because
// a half-answer ("the observed pipeline is stale, couldn't read the legacy
// one") is still worth sending.
//
// Used for `trend_items` only, which is single-platform today — every row the
// ingest writes is `platform: "tiktok"`, since its one adapter reads a TikTok
// endpoint. A global max is therefore the whole story there. The legacy table
// genuinely spans seven platforms and gets the per-platform probe below.
async function newestTimestamp(table, column) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?select=${column}&order=${column}.desc&limit=1`,
      { headers: SUPABASE_HEADERS },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    const raw = rows && rows[0] && rows[0][column];
    if (!raw) return null;
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  } catch (e) {
    console.error("[cron/trend-health] probe failed for", table, e && e.message);
    return null;
  }
}

// [TREND-HEALTH] Per-platform freshness for the weekly research.
//
// A global `max(fetched_at)` is the wrong question for a multi-platform table
// and this monitor originally asked it. Six platforms refreshing on schedule
// while a seventh silently stops still produces a fresh-looking global max, so
// the creators on that seventh platform go dark and the monitor stays quiet.
// That is not hypothetical: LinkedIn currently has one fewer row than every
// other platform, because `cron/trends-refresh` counts an `errored` platform
// and returns the count in a JSON body nobody reads — the same
// alert-only-on-success shape this whole file exists to close.
//
// So health is the OLDEST platform, not the newest row — the same "oldest
// entry wins" rule playbookAge uses, and for the same reason: a creator on the
// lagging platform experiences the lag in full, no matter how current the
// others are. A platform absent from the table entirely counts as lagging.
//
// Note this deliberately does NOT alert on trends-refresh's per-run `errored`
// count. One failed platform that self-corrects on the next weekly run is not
// worth an email; a platform that keeps failing crosses the threshold here and
// is. Monitoring the outcome absorbs the transient and keeps the persistent.
async function legacyFreshnessByPlatform() {
  try {
    // [TRENDS-SEGMENT] Global rows only (`segment IS NULL`). The cron now
    // writes per-segment rows for TikTok, Instagram and LinkedIn on top of the
    // global row per platform. Counting both would let a healthy segment row
    // make a platform look fresh while its global refresh was failing — the
    // same shape as the bug this function already fixed once, where six
    // healthy platforms hid a seventh behind a global max. Measure one tier,
    // and measure the one every creator falls back to.
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/trends?select=platform,fetched_at&segment=is.null&order=fetched_at.desc&limit=500`,
      { headers: SUPABASE_HEADERS },
    );
    if (!res.ok) return { newestByPlatform: new Map(), unreadable: true };
    const rows = await res.json();
    const newestByPlatform = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || !r.platform || !r.fetched_at) continue;
      if (newestByPlatform.has(r.platform)) continue; // rows are desc-sorted
      const t = Date.parse(r.fetched_at);
      if (!Number.isNaN(t)) newestByPlatform.set(r.platform, t);
    }
    return { newestByPlatform, unreadable: false };
  } catch (e) {
    console.error("[cron/trend-health] legacy per-platform probe failed", e && e.message);
    return { newestByPlatform: new Map(), unreadable: true };
  }
}

function ageDays(ts, now) {
  if (ts == null) return null;
  return Math.max(0, Math.floor((now - ts) / DAY_MS));
}

export default async function handler(req, res) {
  if (!cronAuthorized(req, "trend-health")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }

  const now = Date.now();
  const [observedTs, legacy] = await Promise.all([
    newestTimestamp("trend_items", "last_seen"),
    legacyFreshnessByPlatform(),
  ]);

  const observedAge = ageDays(observedTs, now);

  // Per-platform ages, with a missing platform reported as null rather than
  // skipped — "we have never researched Pinterest" and "Pinterest is 20 days
  // stale" are both states a creator on Pinterest feels identically.
  const legacyPlatformAges = {};
  const laggingPlatforms = [];
  for (const p of PLATFORMS) {
    const age = ageDays(legacy.newestByPlatform.get(p), now);
    legacyPlatformAges[p] = age;
    if (age === null || age >= LEGACY_STALE_DAYS) laggingPlatforms.push(p);
  }

  // The reportable legacy age is the WORST platform, so a single lagging
  // channel can't hide behind six healthy ones.
  const knownAges = PLATFORMS.map(p => legacyPlatformAges[p]).filter(a => a !== null);
  const legacyAge = (legacy.unreadable || knownAges.length === 0)
    ? null
    : Math.max(...knownAges);

  // A null age means the table is empty or unreadable. That is NOT healthy —
  // it is the most severe version of the same problem — so it counts as stale
  // rather than being skipped the way an unknown playbook timestamp is. The
  // difference is deliberate: a playbook row with no `updated_at` is a schema
  // gap on data that still exists, whereas no trend row at all means the
  // pipeline has produced nothing, ever or recently.
  const observedStale = observedAge === null || observedAge >= OBSERVED_STALE_DAYS;
  const legacyStale   = laggingPlatforms.length > 0;

  // Both dry is the state creators actually feel: no observed data AND no
  // fallback means every surface renders the "no trends" empty state.
  const bothDark = observedStale && legacyStale;

  let adminUserId = null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(ADMIN_EMAIL)}`,
      { headers: SUPABASE_HEADERS },
    );
    if (r.ok) {
      const j = await r.json();
      const u = (j.users && j.users[0]) || null;
      if (u && u.id) adminUserId = u.id;
    }
  } catch (e) { /* non-fatal */ }

  // Dedupe on the run date so a same-day re-run is a no-op, but a pipeline
  // that stays broken re-alerts every day. That is intentional: a single
  // ignorable email is how the last outage lasted eight days.
  let emailed = false;
  if ((observedStale || legacyStale) && adminUserId) {
    const tpl = trendPipelineStale({
      observedAge, legacyAge, observedStale, legacyStale, bothDark,
      laggingPlatforms,
      totalPlatforms:    PLATFORMS.length,
      observedThreshold: OBSERVED_STALE_DAYS,
      legacyThreshold:   LEGACY_STALE_DAYS,
    });
    const dedupeKey = "trend_health_" + new Date(now).toISOString().slice(0, 10);
    emailed = await sendEmail({
      userId:    adminUserId,
      to:        ADMIN_EMAIL,
      template:  "trend_pipeline_stale",
      dedupeKey,
      subject:   tpl.subject,
      html:      tpl.html,
      text:      tpl.text,
      marketing: false,
    });
  }

  return res.status(200).json({
    ok: true,
    observedAgeDays: observedAge,
    legacyAgeDays:   legacyAge,
    observedStale,
    legacyStale,
    bothDark,
    laggingPlatforms,
    legacyPlatformAges,
    emailed,
  });
}
