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
import { SEGMENT_PLATFORMS }  from "./trends-refresh.js";
import { legacyRowHasItems }  from "../_lib/trend-context.js";

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

// [SEGMENT-HEALTH] The per-segment tier needs a DIFFERENT question asked of it,
// and this is the reason it went unmonitored through a total failure.
//
// Every other check in this file measures the AGE of data, on the argument
// that age catches every mechanism identically. That argument holds when the
// failure stops rows being written. The segment tier's actual failure did not:
// the first week it ran, all 20 rows were written exactly on schedule and 14 of
// them were EMPTY — the research model declining the question it was asked. A
// staleness check would have called that a perfectly healthy tier, because it
// was perfectly fresh. It was simply worthless.
//
// So the segment tier is measured on PRODUCTION, not freshness: how many of the
// (segment, platform) pairs the cron writes came back carrying anything. That
// is the only framing under which the observed outage is visible at all.
//
// The floor is a share rather than a count because the pair list is expected to
// grow. Half is a deliberate, reasoned line, not a measured one: one or two
// verticals genuinely having a quiet week is normal variance and must not page
// anyone, while more than half coming back empty is the tier failing as a whole
// rather than nine independent quiet weeks. Baseline when this was written: 6
// of 20 productive (30%), which this correctly flags. If real weeks routinely
// land near 50% once the tiered prompt has run a few cycles, this number is
// wrong and should be moved with the data in hand rather than defended.
const SEGMENT_PRODUCTIVE_FLOOR = 0.5;

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

// [SEGMENT-HEALTH] Production check on the per-segment research tier.
//
// Reads only segment rows (`segment=not.is.null`) — the exact complement of the
// global probe above, so the two tiers stay independently measurable and a
// healthy one can never vouch for a broken one. That separation is the same
// rule the global probe already documents, applied one level down.
//
// Scored per (segment, platform) PAIR rather than per row, because a pair is
// what a creator experiences: a real estate agent on TikTok is served the
// real_estate/TikTok row or she is served the global fallback instead. Pairs
// come from trends-refresh's own map, so adding a pair there enrolls it here.
//
// A pair with no row at all counts as unproductive, not as absent. Rows that
// produce nothing vanish from any grouping keyed on their items, which is
// precisely how a tier of empty rows can look like a short healthy report.
async function segmentTierHealth(now) {
  const expected = [];
  for (const segment of Object.keys(SEGMENT_PLATFORMS)) {
    for (const platform of SEGMENT_PLATFORMS[segment]) expected.push(segment + "/" + platform);
  }
  if (!expected.length) return null;

  // Same window as the global research check: the tier refreshes weekly, so 10
  // days absorbs one missed run without crying about it.
  const since = new Date(now - LEGACY_STALE_DAYS * DAY_MS).toISOString();
  let rows;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/trends?select=platform,segment,items,fetched_at`
      + `&segment=not.is.null&fetched_at=gte.${encodeURIComponent(since)}`
      + "&order=fetched_at.desc&limit=500",
      { headers: SUPABASE_HEADERS },
    );
    if (!res.ok) return { unreadable: true, expected: expected.length };
    rows = await res.json();
  } catch (e) {
    console.error("[cron/trend-health] segment probe failed", e && e.message);
    return { unreadable: true, expected: expected.length };
  }

  // Rows arrive newest-first, so the first row seen for a pair is its current
  // one — the same row loadLegacyTrends would pick.
  const newestByPair = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.platform || !r.segment) continue;
    const pair = r.segment + "/" + r.platform;
    if (newestByPair.has(pair)) continue;
    newestByPair.set(pair, r);
  }

  const barren = [];
  let fresh = 0;
  let productive = 0;
  for (const pair of expected) {
    const row = newestByPair.get(pair);
    if (row) fresh++;
    // legacyRowHasItems is trend-context's own test, imported rather than
    // restated, so "productive" here means exactly "renders something there".
    if (row && legacyRowHasItems(row)) productive++;
    else barren.push(pair);
  }

  return {
    unreadable: false,
    expected:   expected.length,
    fresh,
    productive,
    // Capped: this lands in an email, and 20 pair names is a wall, not a signal.
    barren:     barren.slice(0, 8),
    barrenCount: barren.length,
  };
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
  const [observedTs, legacy, segments] = await Promise.all([
    newestTimestamp("trend_items", "last_seen"),
    legacyFreshnessByPlatform(),
    segmentTierHealth(now),
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

  // [SEGMENT-HEALTH] Two distinct segment failures, because they need different
  // reactions: the tier not running at all points at the cron, while the tier
  // running and returning nothing points at the research prompt.
  //
  // Deliberately NOT folded into `legacyStale`. Since the empty-row precedence
  // fix, an unproductive segment row falls through to global research rather
  // than blanking the platform, so this is a DEGRADATION — creators get
  // platform-wide research instead of their industry's — not an outage. Rolling
  // it into the outage flag would overstate it and, worse, would make the
  // genuinely dark case indistinguishable in the subject line.
  const segmentReadable = !!(segments && !segments.unreadable);
  const segmentTierDown = segmentReadable && segments.expected > 0 && segments.fresh === 0;
  const segmentThin     = segmentReadable && segments.expected > 0 && !segmentTierDown
    && (segments.productive / segments.expected) < SEGMENT_PRODUCTIVE_FLOOR;
  const segmentDegraded = segmentTierDown || segmentThin;

  // [SEGMENT-HEALTH] The admin lookup is load-bearing: sendEmail dedupes on
  // (user_id, template, dedupe_key), so an unresolved id means no alert at all.
  // The previous version took `users[0]` from a list endpoint that does not
  // filter on `?email=`, which is whichever user the page happened to start
  // with — a different id run to run breaks the daily dedupe, and an empty page
  // silently disables the whole alert. Match the address explicitly instead.
  //
  // If it cannot be resolved, that is logged as an error and reported in the
  // response rather than passed over: a monitor that quietly declines to alert
  // is the precise failure this file was written to end, and it would be a poor
  // joke for it to have that shape itself.
  let adminUserId = null;
  let adminLookupFailed = false;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`,
      { headers: SUPABASE_HEADERS },
    );
    if (r.ok) {
      const j = await r.json();
      const users = (j && Array.isArray(j.users)) ? j.users : [];
      const want = ADMIN_EMAIL.toLowerCase();
      const u = users.find(x => x && typeof x.email === "string" && x.email.toLowerCase() === want);
      if (u && u.id) adminUserId = u.id;
    }
  } catch (e) {
    console.error("[cron/trend-health] admin lookup threw", e && e.message);
  }
  if (!adminUserId) {
    adminLookupFailed = true;
    console.error(
      "[cron/trend-health] could not resolve an id for", ADMIN_EMAIL,
      "— no staleness email can be sent until this resolves.",
    );
  }

  // Dedupe on the run date so a same-day re-run is a no-op, but a pipeline
  // that stays broken re-alerts every day. That is intentional: a single
  // ignorable email is how the last outage lasted eight days.
  let emailed = false;
  if ((observedStale || legacyStale || segmentDegraded) && adminUserId) {
    const tpl = trendPipelineStale({
      observedAge, legacyAge, observedStale, legacyStale, bothDark,
      laggingPlatforms,
      totalPlatforms:    PLATFORMS.length,
      observedThreshold: OBSERVED_STALE_DAYS,
      legacyThreshold:   LEGACY_STALE_DAYS,
      segmentTierDown, segmentThin,
      segmentExpected:   segmentReadable ? segments.expected   : null,
      segmentProductive: segmentReadable ? segments.productive : null,
      segmentBarren:     segmentReadable ? segments.barren     : [],
      segmentBarrenCount: segmentReadable ? segments.barrenCount : 0,
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
    segmentTierDown,
    segmentThin,
    segmentDegraded,
    segmentExpected:   segmentReadable ? segments.expected    : null,
    segmentFresh:      segmentReadable ? segments.fresh       : null,
    segmentProductive: segmentReadable ? segments.productive  : null,
    segmentBarren:     segmentReadable ? segments.barren      : [],
    adminLookupFailed,
    emailed,
  });
}
