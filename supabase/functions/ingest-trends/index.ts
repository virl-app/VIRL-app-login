// ingest-trends — scheduled trend ingestion for VIRL.
//
// Pipeline: fetch → upsert → observe → lifecycle → tag → enrich.
// Scheduled Mon + Thu 06:00 ET (10:00 UTC) via pg_cron + net.http_post.
//
// Auth: deployed with verify_jwt=false and guarded by a shared secret in the
// `x-ingest-secret` header, so pg_cron never has to carry a service-role JWT.
// The `?selftest=1` route is intentionally UNAUTHENTICATED: it runs pure
// in-memory lifecycle assertions, touches no data, calls no vendor, and spends
// nothing — it exists so the scoring logic can be verified in the real Deno
// runtime without provisioning secrets first.

import { ensembleDataSource } from "./adapters/ensembledata.ts";
import { HASHTAG_CONFIG } from "./adapters/hashtags.ts";
import { buildUrl, httpSourceConfigFromEnv, httpTrendSource } from "./adapters/http-source.ts";
import { extractPosts } from "./adapters/tiktok-normalize.ts";
import { scoreLifecycle } from "./lifecycle.ts";
import { LIFECYCLE_CASES } from "./lifecycle.cases.ts";
import {
  enrichContext,
  selectForEnrichment,
  tagNiches,
  type EnrichCandidate,
  type TaggableTrend,
} from "./enrich.ts";
import {
  trendKey,
  type NormalizedTrend,
  type ObservationRow,
  type TrendItemRow,
  type TrendSource,
  type TrendStatus,
} from "./types.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ENSEMBLE_TOKEN = Deno.env.get("ENSEMBLE_TOKEN") ?? "";
const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const INGEST_CRON_SECRET = Deno.env.get("INGEST_CRON_SECRET") ?? "";

/** Bound the single batched tagging call so one huge run can't blow its context. */
const MAX_TAGGING_BATCH = 120;
/** How far back lifecycle scoring looks for prior observations. */
const OBSERVATION_LOOKBACK_DAYS = 30;

const log = (msg: string, extra?: unknown) =>
  console.log(`[ingest-trends] ${msg}`, extra ?? "");

// ── Supabase REST helpers ──────────────────────────────────────────────────
// Raw PostgREST over fetch, matching how the Node side of the app talks to
// Supabase (no SDK anywhere in this codebase).

function sbHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function sbSelect<T>(pathAndQuery: string): Promise<T[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`select ${pathAndQuery} → ${res.status} ${await res.text()}`);
  return await res.json() as T[];
}

async function sbUpsert<T>(
  table: string,
  onConflict: string,
  rows: unknown[],
  returnRows: boolean,
): Promise<T[]> {
  if (rows.length === 0) return [];
  const prefer = `resolution=merge-duplicates,return=${returnRows ? "representation" : "minimal"}`;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
    { method: "POST", headers: sbHeaders({ Prefer: prefer }), body: JSON.stringify(rows) },
  );
  if (!res.ok) throw new Error(`upsert ${table} → ${res.status} ${await res.text()}`);
  return returnRows ? await res.json() as T[] : [];
}

async function sbInsert(table: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: sbHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`insert ${table} → ${res.status} ${await res.text()}`);
}

async function sbPatchIds(table: string, ids: string[], patch: unknown): Promise<void> {
  if (ids.length === 0) return;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?id=in.(${ids.join(",")})`,
    { method: "PATCH", headers: sbHeaders({ Prefer: "return=minimal" }), body: JSON.stringify(patch) },
  );
  if (!res.ok) throw new Error(`patch ${table} → ${res.status} ${await res.text()}`);
}

async function sbPatchById(table: string, id: string, patch: unknown): Promise<void> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`,
    { method: "PATCH", headers: sbHeaders({ Prefer: "return=minimal" }), body: JSON.stringify(patch) },
  );
  if (!res.ok) throw new Error(`patch ${table} #${id} → ${res.status} ${await res.text()}`);
}

// Shared enrichment step: pick qualifying trends that still lack context and
// give each one a Perplexity-sourced explanation + 3 angles. Used by the main
// run AND the ?enrichonly backfill route. Targets by "context is null" (not
// "tagged this run") so a backlog — e.g. trends tagged during a Perplexity
// outage — drains 10 at a time and nothing is ever re-paid for.
async function enrichMissingContext(onlySeenSince?: string): Promise<{ eligible: number; enriched: number }> {
  if (!PERPLEXITY_API_KEY) return { eligible: 0, enriched: 0 };
  let q = "trend_items?select=id,display_name,status,niche_scores" +
    "&context=is.null&status=in.(new,rising)&limit=300";
  if (onlySeenSince) q += `&last_seen=gte.${encodeURIComponent(onlySeenSince)}`;
  const rows = await sbSelect<{ id: string; display_name: string; status: TrendStatus; niche_scores: Record<string, number> | null }>(q);

  const candidates: EnrichCandidate[] = rows
    .filter((r) => r.niche_scores && Object.keys(r.niche_scores).length > 0)
    .map((r) => ({ id: r.id, displayName: r.display_name, status: r.status, scores: r.niche_scores as Record<string, number> }));

  const selected = selectForEnrichment(candidates);
  if (selected.length === 0) return { eligible: candidates.length, enriched: 0 };

  const contexts = await enrichContext(selected, { apiKey: PERPLEXITY_API_KEY, log: (m, e) => log(`ctx: ${m}`, e) });
  for (const [id, ctx] of contexts) {
    await sbPatchById("trend_items", id, {
      context: ctx.context,
      suggested_angles: ctx.angles,
      updated_at: new Date().toISOString(),
    });
  }
  return { eligible: candidates.length, enriched: contexts.size };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── selftest ───────────────────────────────────────────────────────────────

function runSelfTest() {
  const results = LIFECYCLE_CASES.map((c) => {
    let actual: string;
    try {
      actual = scoreLifecycle(c.input);
    } catch (e) {
      actual = `THREW: ${e instanceof Error ? e.message : String(e)}`;
    }
    return { name: c.name, expected: c.expected, actual, pass: actual === c.expected };
  });
  const failed = results.filter((r) => !r.pass);
  return { ok: failed.length === 0, total: results.length, passed: results.length - failed.length, failed: failed.length, results };
}

// ── orchestrator ───────────────────────────────────────────────────────────

async function runIngest() {
  const startedAt = new Date();
  const summary: Record<string, unknown> = { startedAt: startedAt.toISOString() };
  // Presence of each optional key (never the value) — makes "why was tagging /
  // enrichment skipped?" obvious from the run summary alone.
  summary.keys = {
    ensemble: !!ENSEMBLE_TOKEN,
    httpSource: !!Deno.env.get("TREND_HTTP_TOKEN"),
    anthropic: !!ANTHROPIC_API_KEY,
    perplexity: !!PERPLEXITY_API_KEY,
  };

  // 1. Run every enabled adapter. A failing adapter must never fail the run.
  const sources: TrendSource[] = [];
  if (ENSEMBLE_TOKEN) {
    sources.push(ensembleDataSource({ token: ENSEMBLE_TOKEN, log: (m, e) => log(`ensembledata: ${m}`, e) }));
  } else {
    log("ENSEMBLE_TOKEN missing — ensembledata adapter disabled");
  }

  // Vendor-agnostic pay-as-you-go source. Runs ALONGSIDE EnsembleData rather
  // than replacing it — the dedupe below already collapses a trend seen by two
  // sources into one row keeping the richer view, so a cutover can overlap for
  // a week and be compared rather than switched blind.
  try {
    const httpCfg = httpSourceConfigFromEnv((k) => Deno.env.get(k));
    if (httpCfg) {
      sources.push(httpTrendSource({
        urlTemplate: httpCfg.urlTemplate,
        token: httpCfg.token,
        header: httpCfg.header,
        prefix: httpCfg.prefix,
        name: httpCfg.name,
        maxCalls: httpCfg.maxCalls,
        hashtags: HASHTAG_CONFIG,
        log: (m, e) => log(`${httpCfg.name}: ${m}`, e),
      }));
      summary.httpSource = httpCfg.name;
    } else {
      log("TREND_HTTP_URL / TREND_HTTP_TOKEN unset — http-source adapter disabled");
    }
  } catch (e) {
    // Half-configured is a deploy mistake, and the whole point of this change
    // is that a misconfigured source stops looking like a quiet week.
    const error = e instanceof Error ? e.message : String(e);
    log("http-source CONFIG ERROR — adapter not registered", error);
    summary.httpSourceConfigError = error;
  }

  const fetched: NormalizedTrend[] = [];
  const sourceReport: Array<{ name: string; ok: boolean; count: number; error?: string }> = [];
  for (const src of sources) {
    try {
      const items = await src.fetch();
      fetched.push(...items);
      sourceReport.push({ name: src.name, ok: true, count: items.length });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log(`adapter ${src.name} failed — continuing with other sources`, error);
      sourceReport.push({ name: src.name, ok: false, count: 0, error });
    }
  }
  summary.sources = sourceReport;

  // Collapse duplicates (same trend from two sources) keeping the richest row.
  const byKey = new Map<string, NormalizedTrend>();
  for (const t of fetched) {
    const k = trendKey(t);
    const prior = byKey.get(k);
    if (!prior || (t.views ?? 0) > (prior.views ?? 0)) byKey.set(k, t);
  }
  const trends = [...byKey.values()];
  const emptyRun = trends.length === 0;
  summary.fetched = trends.length;
  summary.emptyRun = emptyRun;

  // 2. Fail-soft. An empty run says something about the adapters, not the
  //    trends — so do nothing at all rather than cascading everything to dead.
  //
  //    [SOURCE-HEALTH] The fail-soft behaviour is unchanged and correct. What
  //    changes is what the summary CALLS it. "Every adapter was refused by its
  //    vendor" and "every adapter searched and found nothing" both landed here
  //    and both printed the same line, so the summary read as a quiet week
  //    during a nine-day billing outage. The two now report separately, and
  //    the failure case names the adapter and its error rather than sending
  //    the reader to the logs to reconstruct it.
  if (emptyRun) {
    const failed = sourceReport.filter((s) => !s.ok);
    summary.sourcesFailed = failed.length;
    if (failed.length > 0) {
      const detail = failed.map((s) => `${s.name}: ${s.error}`).join(" | ");
      log(`ALL ADAPTERS FAILED — this is NOT an empty week. ${detail}`);
      summary.note =
        `empty run caused by ADAPTER FAILURE, not absent trends — no writes performed. ${detail}`;
    } else if (sources.length === 0) {
      log("NO ADAPTERS ENABLED — every source is missing its credentials.");
      summary.note = "empty run: no adapters enabled (missing credentials); no writes performed";
    } else {
      log("ALL ADAPTERS RETURNED EMPTY — no writes, no lifecycle transitions. Check adapter health.");
      summary.note = "empty run: adapters ran and returned nothing; no writes performed";
    }
    return summary;
  }

  // 3. Upsert identity + last_seen. Deliberately omits status / niche_scores /
  //    context / first_seen so an existing row keeps everything it has learned
  //    and a new row picks up the column defaults (status='new').
  const upsertRows = trends.map((t) => ({
    platform: t.platform,
    type: t.type,
    normalized_name: t.normalizedName,
    display_name: t.displayName,
    external_url: t.externalUrl ?? null,
    region: t.region,
    source: "ensembledata",
    last_seen: startedAt.toISOString(),
  }));

  const upserted: TrendItemRow[] = [];
  for (const part of chunk(upsertRows, 200)) {
    upserted.push(...await sbUpsert<TrendItemRow>("trend_items", "platform,type,normalized_name,region", part, true));
  }
  const idByKey = new Map(upserted.map((r) => [trendKey(r), r.id]));
  const rowById = new Map(upserted.map((r) => [r.id, r]));
  summary.upserted = upserted.length;

  // 4. Always append one observation per trend per run.
  const observationRows = trends.flatMap((t) => {
    const id = idByKey.get(trendKey(t));
    if (!id) return [];
    return [{
      trend_item_id: id,
      rank: t.rank ?? null,
      views: t.views ?? null,
      post_count: t.postCount ?? null,
      raw: t.raw,
    }];
  });
  for (const part of chunk(observationRows, 200)) await sbInsert("trend_observations", part);
  summary.observations = observationRows.length;

  // 5. Lifecycle. Score EVERY trend in the table (not just this run's) so
  //    absences are detected — and include dead ones so a resurfaced trend can
  //    come back to life.
  const allTrends = await sbSelect<TrendItemRow>(
    "trend_items?select=id,platform,type,normalized_name,display_name,region,source,status,last_seen,niche_scores&limit=5000",
  );
  const seenIds = new Set(idByKey.values());

  const since = new Date(startedAt.getTime() - OBSERVATION_LOOKBACK_DAYS * 86400_000).toISOString();
  const obsByTrend = new Map<string, ObservationRow[]>();
  for (const part of chunk(allTrends.map((t) => t.id), 100)) {
    const rows = await sbSelect<ObservationRow & { trend_item_id: string }>(
      `trend_observations?select=trend_item_id,observed_at,rank,views,post_count` +
      `&trend_item_id=in.(${part.join(",")})&observed_at=gte.${since}&order=observed_at.asc&limit=10000`,
    );
    for (const r of rows) {
      const list = obsByTrend.get(r.trend_item_id) ?? [];
      list.push(r);
      obsByTrend.set(r.trend_item_id, list);
    }
  }

  const statusChanges = new Map<TrendStatus, string[]>();
  const changedIds = new Set<string>();
  const nextStatusById = new Map<string, TrendStatus>();
  for (const t of allTrends) {
    const next = scoreLifecycle({
      observations: obsByTrend.get(t.id) ?? [],
      presentInLatestRun: seenIds.has(t.id),
      lastSeen: t.last_seen,
      now: startedAt,
      emptyRun: false,
      currentStatus: t.status,
    });
    nextStatusById.set(t.id, next);
    if (next !== t.status) {
      statusChanges.set(next, [...(statusChanges.get(next) ?? []), t.id]);
      changedIds.add(t.id);
    }
  }
  for (const [status, ids] of statusChanges) {
    for (const part of chunk(ids, 200)) {
      await sbPatchIds("trend_items", part, { status, updated_at: new Date().toISOString() });
    }
  }
  summary.statusChanges = Object.fromEntries([...statusChanges].map(([s, ids]) => [s, ids.length]));

  // 6. Niche tagging — ONE batched Claude call for trends that are untagged or
  //    just changed state.
  let tagged = 0;
  if (ANTHROPIC_API_KEY) {
    const needTags: TaggableTrend[] = [];
    for (const t of trends) {
      const id = idByKey.get(trendKey(t));
      if (!id) continue;
      // The upsert representation already carries current niche_scores, so a
      // trend only needs the model if it has never been tagged or just moved.
      const row = rowById.get(id);
      const untagged = !row?.niche_scores || Object.keys(row.niche_scores).length === 0;
      if (untagged || changedIds.has(id)) {
        needTags.push({ id, displayName: t.displayName, type: t.type, platform: t.platform, views: t.views, postCount: t.postCount });
      }
    }
    if (needTags.length > MAX_TAGGING_BATCH) {
      log(`tagging batch truncated: ${MAX_TAGGING_BATCH}/${needTags.length} trends this run`);
    }
    const batch = needTags.slice(0, MAX_TAGGING_BATCH);
    const tags = await tagNiches(batch, { apiKey: ANTHROPIC_API_KEY, log: (m, e) => log(`tag: ${m}`, e) });

    // Write back through the same unique key so one request updates many rows.
    const tagUpserts = [...tags].flatMap(([id, tag]) => {
      const row = rowById.get(id);
      if (!row) return [];
      // The adaptability note rides along inside niche_scores per the brief.
      // The leading underscore keeps it out of the canonical-segment namespace
      // that the generation-side `(niche_scores->>$SEGMENT)::float` cast reads.
      const scores: Record<string, unknown> = { ...tag.scores };
      if (tag.note) scores._note = tag.note;
      return [{
        platform: row.platform,
        type: row.type,
        normalized_name: row.normalized_name,
        region: row.region,
        display_name: row.display_name,
        source: row.source ?? "ensembledata",
        niche_scores: scores,
        updated_at: new Date().toISOString(),
      }];
    });
    for (const part of chunk(tagUpserts, 200)) {
      await sbUpsert("trend_items", "platform,type,normalized_name,region", part, false);
    }
    tagged = tagUpserts.length;

    // 7. Context enrichment — hard-capped Perplexity calls on qualifying trends
    //    seen this run that still lack context.
    if (PERPLEXITY_API_KEY) {
      const { eligible, enriched } = await enrichMissingContext(startedAt.toISOString());
      summary.enriched = enriched;
      summary.enrichEligible = eligible;
    } else {
      log("PERPLEXITY_API_KEY missing — context enrichment skipped");
      summary.enriched = 0;
    }
  } else {
    log("ANTHROPIC_API_KEY missing — niche tagging and context enrichment skipped");
  }
  summary.tagged = tagged;

  summary.durationMs = Date.now() - startedAt.getTime();
  log("run complete", summary);
  return summary;
}

// ── HTTP entrypoint ────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });

  // Unauthenticated on purpose: pure computation, no data, no spend.
  if (url.searchParams.get("selftest") === "1") {
    const result = runSelfTest();
    return json(result, result.ok ? 200 : 500);
  }

  if (!INGEST_CRON_SECRET) {
    return json({ error: "INGEST_CRON_SECRET is not configured on this function." }, 500);
  }
  if (req.headers.get("x-ingest-secret") !== INGEST_CRON_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unavailable" }, 500);
  }

  // Secret-gated backfill: run ONLY the enrichment step over qualifying trends
  // that still lack context — no EnsembleData, no tagging. Costs up to 10
  // Perplexity calls. Useful to top up context without spending the daily
  // EnsembleData budget (e.g. after fixing the Perplexity key).
  // Secret-gated single-call probe against the configured http-source.
  //
  // The one thing that cannot be known about a new provider without spending a
  // call is the shape it replies in — and a wrong guess presents as "returned
  // no posts", which is indistinguishable from a quiet week until you go
  // reading logs. This spends ONE call on ONE hashtag and reports the envelope
  // directly: the status, the top-level keys, whether extractPosts() found the
  // array, and the field names on the first post. Enough to either confirm the
  // adapter works or to add the right path to extractPosts() and retry.
  //
  // The token is never echoed, only its presence and the redacted URL.
  if (url.searchParams.get("sourcetest") === "1") {
    try {
      const cfg = httpSourceConfigFromEnv((k) => Deno.env.get(k));
      if (!cfg) {
        return json({ error: "http-source is not configured (TREND_HTTP_URL / TREND_HTTP_TOKEN unset)." }, 400);
      }
      const tag = url.searchParams.get("tag") || HASHTAG_CONFIG[0].tag;
      const probeUrl = buildUrl(cfg.urlTemplate, tag, cfg.token);
      const headers: Record<string, string> = { accept: "application/json" };
      if (cfg.header) headers[cfg.header] = `${cfg.prefix ?? ""}${cfg.token}`;

      const res = await fetch(probeUrl, { headers });
      const bodyText = await res.text();
      let payload: unknown = null;
      try { payload = JSON.parse(bodyText); } catch { /* keep as text */ }

      const posts = payload ? extractPosts(payload) : [];
      const firstPost = posts[0];

      return json({
        mode: "sourcetest",
        provider: cfg.name,
        tag,
        // Redact the token wherever it appears (query string or header).
        url: probeUrl.split(encodeURIComponent(cfg.token)).join("<TOKEN>"),
        authHeader: cfg.header ? `${cfg.header}: ${cfg.prefix ?? ""}<TOKEN>` : "(none — token in query string)",
        httpStatus: res.status,
        parsedAsJson: payload !== null,
        topLevelKeys: payload && typeof payload === "object" ? Object.keys(payload as object).slice(0, 40) : [],
        postsFound: posts.length,
        firstPostKeys: firstPost && typeof firstPost === "object" ? Object.keys(firstPost as object).slice(0, 60) : [],
        // The two fields the pipeline actually needs off each post.
        firstPostHasMusic: !!(firstPost && typeof firstPost === "object" && "music" in (firstPost as object)),
        bodyPreview: payload === null ? bodyText.slice(0, 500) : undefined,
        verdict: posts.length > 0
          ? "OK — envelope recognized, adapter should work."
          : res.ok
            ? "RESPONDED BUT NO POSTS FOUND — the envelope is not in extractPosts()'s candidate list. Add the correct path from topLevelKeys above."
            : "REQUEST REJECTED — check the URL template, auth header, and token.",
      });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  if (url.searchParams.get("enrichonly") === "1") {
    try {
      return json({ mode: "enrichonly", ...(await enrichMissingContext()) });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  try {
    return json(await runIngest());
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log("run FAILED", error);
    return json({ error }, 500);
  }
});
