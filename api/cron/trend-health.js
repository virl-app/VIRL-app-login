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
  const [observedTs, legacyTs] = await Promise.all([
    newestTimestamp("trend_items", "last_seen"),
    newestTimestamp("trends", "fetched_at"),
  ]);

  const observedAge = ageDays(observedTs, now);
  const legacyAge   = ageDays(legacyTs, now);

  // A null age means the table is empty or unreadable. That is NOT healthy —
  // it is the most severe version of the same problem — so it counts as stale
  // rather than being skipped the way an unknown playbook timestamp is. The
  // difference is deliberate: a playbook row with no `updated_at` is a schema
  // gap on data that still exists, whereas no trend row at all means the
  // pipeline has produced nothing, ever or recently.
  const observedStale = observedAge === null || observedAge >= OBSERVED_STALE_DAYS;
  const legacyStale   = legacyAge   === null || legacyAge   >= LEGACY_STALE_DAYS;

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
    emailed,
  });
}
