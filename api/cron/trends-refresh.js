// Weekly trends refresh. Runs SATURDAY 07:00 UTC (see vercel.json).
//
// [WEEK-START] It ran Mondays until planning weeks became creator-anchored
// with a Sunday default. Trend rows are hard-filtered at 7 days
// (TREND_FRESHNESS_DAYS in api/_lib/trend-context.js), so a Monday refresh
// meant a Sunday-anchored plan — the moment most creators generate — was
// built on day-six data sitting right at the cutoff, with a late-Sunday
// generation liable to have items dropped entirely. Refreshing the day
// BEFORE the default week start puts the freshest research in front of the
// plan that actually uses it. Move this again if the default anchor moves.
//
// Auto-publishes — no admin approval. Each row in
// public.trends is dated and lists the URLs the model cited; users see the
// freshness on the Algo tab and can form their own judgment. Plan / scan /
// caption prompts pull the latest row per platform and weave the items in.
//
// Auth: CRON_SECRET-gated (Vercel sends `Authorization: Bearer ${CRON_SECRET}`).
//
// [TRENDS-SEGMENT] This cron used to call researchTrends(platform) with no
// second argument, which researchTrends documents as the "global,
// niche-agnostic" path. Every row was therefore a platform-wide recap — and
// once the trend-fallback started feeding these rows into generation, that
// meant a real estate agent's plan could be built on general TikTok culture
// ("the Microwave Challenge", "the Puerto Rico Song lip-sync format"), because
// the fallback applies no niche filter the way the observed path does.
//
// researchTrends has always accepted `{ niche }` — the inline per-generation
// path passes it. Only this cron didn't. Now it writes two tiers:
//
//   GLOBAL  (segment NULL)  one row per platform, exactly as before. Still
//                           backs the Algo tab, still the fallback when a
//                           creator's segment has no fresh row.
//   SEGMENT (segment set)   one row per (segment, platform) over the pairs in
//                           SEGMENT_PLATFORMS below, researched with the
//                           segment's niche label so the search is pointed at
//                           that vertical.
//
// Cost: 7 global + 31 segment = 38 Perplexity calls a week, against 7 before
// the tier existed and 27 before it covered every platform the playbook names.
// At sonar-pro that is still low-double-digit dollars a month at most, and it
// is the difference between a trend block about this creator's industry and
// one about TikTok.
//
// [REFRESH-TIER] 38 jobs at ~17s each over 3 workers is ~215s before any
// rate-limit backoff, against a 300s ceiling — the same arithmetic that
// killed the 2026-08-17 run at job 13. So the two tiers run as two
// invocations (`?tier=global`, `?tier=segment`; see vercel.json) rather than
// one. The global tier — the row every creator falls back to — gets its own
// short run that segment volume can never truncate. No `tier` runs everything,
// so a manual invocation and the existing tests behave as before.

import { researchTrends } from "../_lib/trends-research.js";
import { cronAuthorized } from "../_lib/cron-auth.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const PLATFORMS = ["TikTok","Instagram","Facebook","YouTube","LinkedIn","X","Pinterest"];

// [REFRESH-CONCURRENCY] How many research calls may be in flight at once. See
// the worker pool in the handler for the measurements behind this. Four is
// chosen to be obviously safe against a rate limit while cutting the run from
// roughly 7.5 minutes to roughly 2 — the constraint is the function's duration
// ceiling, and the headroom matters because a call gets SLOWER as the prompt
// gets better at finding things.
// [RATE-LIMIT] Lowered 4 -> 3 after the 2026-08-22 run: four simultaneous
// sonar-pro calls at search_context_size "high" tripped Perplexity's request
// rate limit and 23 of 27 jobs came back 429. Three in flight, with the
// bounded backoff in perplexity.js absorbing what still trips, keeps the run
// inside the 300s ceiling (27 jobs / 3 x ~17s ~= 155s, plus backoff) without
// re-creating the burst.
const REFRESH_CONCURRENCY = 3;

// [TRENDS-SEGMENT] The nine canonical segment keys, with the human-readable
// label handed to researchTrends. The label is what lands in the prompt
// ("Niche focus: Real Estate creators specifically"), so it is written the way
// a person would say it, not as the snake_case key.
//
// Keys must match playbook_segments.segment_key, the niche_scores keys on
// trend_items, and CANONICAL_SEGMENTS in api/_lib/trend-context.js. The CHECK
// constraint added in migration 026 enforces the same list at the database.
export const SEGMENT_LABELS = {
  real_estate:    "Real Estate",
  coach:          "Coaching and Consulting",
  creator:        "Content Creator",
  personal_brand: "Personal Brand and Thought Leadership",
  small_business: "Small Business Owner",
  fitness:        "Fitness and Training",
  healthcare:     "Healthcare and Medical",
  beauty:         "Beauty and Esthetics",
  hair:           "Hair and Salon",
};

// Which platforms get a per-segment row.
//
// Derived from `playbook_segments.platform_priority` — the strategist's own
// statement of where each segment's audience is — plus TikTok for every
// segment, because TikTok is FALLBACK_PLATFORM in trend-context.js: its
// segment row is the one that crosses platforms and reaches every creator
// regardless of where they post, which makes it the single highest-leverage
// row to make niche-specific.
//
// This map used to cover TikTok and Instagram only, with LinkedIn for two
// segments, on the reasoning that "the weak platforms in the current data
// (Pinterest at ~1 item/week, X at zero across seven weeks) would only
// produce more empty rows". That was true when written and stopped being true
// on 2026-08-10, when the per-platform research frames shipped: over the six
// weeks to 2026-09-08 the global rows averaged Pinterest 6.5, Facebook 5.8,
// LinkedIn 6.5, X 6.4 items a week. Meanwhile the profiles table had 6
// creators on Facebook, 5 on Pinterest and 9 on LinkedIn with either no
// segment row at all or one for two segments of nine — every one of them
// served platform-wide research, or a TikTok row borrowed across, in place of
// their own industry's. The reason for the narrow map had expired and the
// map had not moved with it.
//
// X is deliberately absent: no segment's platform_priority names it, so an X
// creator gets the X global row plus their segment's TikTok row borrowed
// across — the same as before. Add X to a segment here the day the playbook
// says its audience is there, not before.
//
// Keep this in step with platform_priority. The SQL that diffs them:
//   select segment_key, platform_priority from playbook_segments;
// A pair present there and absent here is a creator being served the wrong
// tier. Adding a pair costs one Perplexity call a week and is automatically
// monitored — cron/trend-health.js reads this map, so a new pair that comes
// back empty shows up in the segment-health email rather than going unwatched.
export const SEGMENT_PLATFORMS = {
  real_estate:    ["TikTok", "Instagram", "Facebook"],
  coach:          ["TikTok", "Instagram", "LinkedIn", "YouTube"],
  creator:        ["TikTok", "Instagram", "YouTube"],
  personal_brand: ["TikTok", "Instagram", "LinkedIn", "YouTube"],
  small_business: ["TikTok", "Instagram", "Facebook", "YouTube"],
  fitness:        ["TikTok", "Instagram", "YouTube"],
  healthcare:     ["TikTok", "Instagram", "Facebook", "YouTube"],
  beauty:         ["TikTok", "Instagram", "Pinterest"],
  hair:           ["TikTok", "Instagram", "Pinterest"],
};

const SUPABASE_HEADERS = {
  apikey:        SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function insertTrend(platform, segment, summary, items, sources) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/trends`, {
    method:  "POST",
    headers: Object.assign({}, SUPABASE_HEADERS, { Prefer: "return=minimal" }),
    body: JSON.stringify({
      platform,
      // NULL is the global row, not a missing value — see migration 026.
      segment: segment || null,
      summary: summary || "",
      items:   items   || [],
      sources: sources || [],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      "[cron/trends-refresh] insert failed for", platform, segment || "(global)", res.status, text,
    );
    return false;
  }
  return true;
}

// One research call → one row. Returns "published" | "errored".
//
// `segment` null runs the original niche-agnostic query; a segment key passes
// its label through to researchTrends so the search targets that vertical.
async function refreshOne(platform, segment) {
  let result;
  try {
    result = segment
      ? await researchTrends(platform, { niche: SEGMENT_LABELS[segment] })
      : await researchTrends(platform);
  } catch (e) {
    console.error("[cron/trends-refresh] research threw for", platform, segment || "(global)", e.message);
    return "errored";
  }
  if (!result) return "errored";
  // Always insert a row (even with zero items) so the Algo tab shows the
  // freshness — "we checked, nothing notable" is information too.
  const ok = await insertTrend(platform, segment, result.summary, result.items, result.sources);
  return ok ? "published" : "errored";
}

export default async function handler(req, res) {
  if (!cronAuthorized(req, "trends-refresh")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }

  // [REFRESH-TIER] Which tier(s) this invocation runs. Same query-param
  // pattern as email-triggers' `?job=`. Anything other than the two named
  // tiers — including no param — runs both, so a manual call is the full
  // refresh and the request cannot be mis-typed into doing nothing.
  const tier = (req.query && req.query.tier) || "";
  const runGlobal  = tier !== "segment";
  const runSegment = tier !== "global";

  // Build the full work list up front so the counts in the response describe
  // a plan rather than whatever happened to run before something threw.
  const jobs = [];
  if (runGlobal) {
    for (const platform of PLATFORMS) jobs.push({ platform, segment: null });
  }
  if (runSegment) {
    for (const segment of Object.keys(SEGMENT_PLATFORMS)) {
      for (const platform of SEGMENT_PLATFORMS[segment]) jobs.push({ platform, segment });
    }
  }

  let published = 0;
  let errored   = 0;
  const failed  = [];

  // [REFRESH-CONCURRENCY] This loop was sequential, on the reasoning that a
  // weekly job has "no latency budget" and that 27 concurrent Perplexity calls
  // is how you discover a rate limit. The second half is still true. The first
  // half stopped being true the moment the research prompt started working.
  //
  // Measured on the 2026-08-17 run, from the fetched_at timestamps it wrote:
  //
  //   07:02:03  TikTok    (global)  12 items
  //   07:02:18  Instagram (global)  12      ← ~15-17s apart
  //   07:02:39  YouTube   (global)   0      ← 4s: an EMPTY answer is nearly free
  //   ...
  //   07:04:38  coach/TikTok        12
  //   (stops at job 13 of 27, in exact job order)
  //
  // A productive call costs ~17s and an empty one ~4s. While most rows came
  // back empty the whole run finished comfortably; once the retiered prompt
  // made them productive, 27 sequential calls became ~7.5 minutes and the
  // platform killed the function partway. The rows are truncated in job order
  // with no gaps, which is the signature of a process kill rather than of
  // individual failures — refreshOne catches its own errors and continues, so
  // nothing short of a kill can end the loop early.
  //
  // The cost of that: 14 of 20 segment pairs got no row, so those creators
  // silently fall back to platform-wide research. The tier is funded, running,
  // and half-delivering.
  //
  // A small worker pool fixes it without touching the rate-limit concern that
  // motivated the original design. At 4 in flight the same 27 jobs take ~2
  // minutes rather than ~7.5, which fits inside the ceiling with room for calls
  // to get slower as the prompt improves further. Deliberately a small fixed
  // number and not `Promise.all(jobs)` — the point is to bound the burst, not
  // remove the bound.
  //
  // Each worker still runs its own jobs strictly one at a time, so this changes
  // how many calls are in flight, never how many are made.
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      const outcome = await refreshOne(job.platform, job.segment);
      if (outcome === "published") published++;
      else {
        errored++;
        failed.push(`${job.platform}/${job.segment || "global"}`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(REFRESH_CONCURRENCY, jobs.length) }, worker),
  );

  // [TREND-HEALTH] `failed` is returned by name rather than as a bare count.
  // The prior version returned only `errored`, into a JSON body nobody reads —
  // which is how LinkedIn came to be a week behind every other platform
  // without anything noticing. The daily staleness monitor is still the real
  // safety net; this just means the response says which one when someone looks.
  return res.status(200).json({
    ok: true,
    tier: tier || "all",
    planned: jobs.length,
    published,
    errored,
    failed,
  });
}
