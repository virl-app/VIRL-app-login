// Weekly trends refresh. Auto-publishes — no admin approval. Each row in
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
// Cost: 7 global + 20 segment = 27 Perplexity calls a week, against 7 before.
// At sonar-pro that is single-digit dollars a month, and it is the difference
// between a trend block about this creator's industry and one about TikTok.

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
const REFRESH_CONCURRENCY = 4;

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
// Not every platform for every segment: that would be 63 calls for signal
// most creators never see, and the weak platforms in the current data
// (Pinterest at ~1 item/week, X at zero across seven weeks) would only produce
// more empty rows. TikTok and Instagram carry the volume and the quality, and
// TikTok is additionally the FALLBACK_PLATFORM in trend-context.js — its rows
// reach every creator regardless of the platform they target, which makes it
// the single highest-leverage row to make niche-specific.
//
// LinkedIn is added for the two segments whose audiences are actually there.
// This map is the knob to turn as segments grow; adding a pair costs one
// Perplexity call a week.
// [SEGMENT-HEALTH] Exported so cron/trend-health.js can monitor exactly the
// pairs this cron writes. Duplicating the map there would mean a pair added
// here is silently unmonitored — the same drift that let the segment tier fail
// unwatched in the first place.
export const SEGMENT_PLATFORMS = {
  real_estate:    ["TikTok", "Instagram"],
  coach:          ["TikTok", "Instagram", "LinkedIn"],
  creator:        ["TikTok", "Instagram"],
  personal_brand: ["TikTok", "Instagram", "LinkedIn"],
  small_business: ["TikTok", "Instagram"],
  fitness:        ["TikTok", "Instagram"],
  healthcare:     ["TikTok", "Instagram"],
  beauty:         ["TikTok", "Instagram"],
  hair:           ["TikTok", "Instagram"],
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

  // Build the full work list up front so the counts in the response describe
  // a plan rather than whatever happened to run before something threw.
  const jobs = [];
  for (const platform of PLATFORMS) jobs.push({ platform, segment: null });
  for (const segment of Object.keys(SEGMENT_PLATFORMS)) {
    for (const platform of SEGMENT_PLATFORMS[segment]) jobs.push({ platform, segment });
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
    planned: jobs.length,
    published,
    errored,
    failed,
  });
}
