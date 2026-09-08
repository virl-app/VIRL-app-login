// YouTube adapter, on the YouTube Data API v3.
//
// The first observed source that is not TikTok, and the first that costs
// nothing: the Data API's free quota is 10,000 units a day, and a full run here
// spends about 2,100. It exists because the observed pipeline was a single
// TikTok adapter for its whole life, which meant "measurably rising" was a
// claim VIRL could make on one platform and had to fake, or decline, on the
// other six. The research tier covers the rest with what is being TALKED
// about; only an observed source can say what is being WATCHED.
//
// What counts as a trend here, and why it is not the TikTok shape:
//
//   search_term  One row per configured query. The most-viewed videos
//                published in the last RECENT_DAYS are sampled, their views
//                summed and their count taken — the same views/postCount
//                pair the lifecycle scorer already reads, so a query whose
//                weekly view mass is climbing scores `rising` with no new
//                scoring code. This is the measured twin of the research
//                frame's "topics getting outsized search and view demand".
//
//   hashtag      Aggregated ACROSS queries from `#tags` in the sampled videos'
//                titles and descriptions, exactly as the TikTok adapters
//                aggregate sounds across hashtags. A tag on one video is
//                noise; on MIN_VIDEOS_PER_TAG it is a trend. Real hashtags
//                only — `snippet.tags` are the creator's private keywords,
//                not something a viewer can follow, so they are ignored.
//
//   There are no sounds. YouTube's demand moves on topics and packaging, not
//   audio, and inventing a sound row to match the TikTok shape would be the
//   kind of unfalsifiable claim the trend-grounding rule exists to stop.
//
// Refusals: an exhausted quota is HTTP 403 with reason `quotaExceeded`, and a
// bad key is 400 `keyInvalid`. 403 is already in isRefusal; the 400 falls to
// the allCallsFailed backstop. Either way the run reports ok:false with the
// body's reason, never a quiet week.

import type { NormalizedTrend, TrendSource } from "../types.ts";
import { allCallsFailed, isRefusal, normalizeName, refusalReason } from "./tiktok-normalize.ts";
import { YOUTUBE_SEARCH_CONFIG } from "./youtube-terms.ts";

const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

/** Quota cost of the two calls a query makes. search.list is the expensive one. */
export const SEARCH_UNITS = 100;
export const VIDEOS_UNITS = 1;

/**
 * Hard ceiling on queries per run. 25 × 101 units ≈ 2,525, so two runs a week
 * spend about half of ONE day's free quota — the cap exists so a growing
 * config list can never reach it silently, same as MAX_UNITS on EnsembleData.
 */
export const MAX_SEARCHES = 25;

/** Only videos published inside this window are sampled. Matches TREND_FRESHNESS_DAYS. */
const RECENT_DAYS = 7;
/** Sample size per query. The API maximum, and one videos.list call covers it. */
const RESULTS_PER_SEARCH = 25;
/** A hashtag must appear on at least this many sampled videos to count as a trend. */
const MIN_VIDEOS_PER_TAG = 2;

export const SOURCE_NAME = "youtube-data-api";

export interface YouTubeOptions {
  apiKey: string;
  region?: string;
  terms?: Array<{ term: string; segment: string }>;
  maxSearches?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}

interface TagTally { tag: string; videos: number; views: number }

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** `#realestate` style tags from free text, lowercased, deduped per video. */
export function extractHashtags(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? "").matchAll(/#([A-Za-z][A-Za-z0-9_]{2,})/g)) out.add(m[1].toLowerCase());
  return [...out];
}

export function youtubeSource(opts: YouTubeOptions): TrendSource {
  const region = opts.region ?? "US";
  const terms = opts.terms ?? YOUTUBE_SEARCH_CONFIG;
  const maxSearches = opts.maxSearches ?? MAX_SEARCHES;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((m: string, e?: unknown) => console.log(`[youtube] ${m}`, e ?? ""));

  return {
    name: SOURCE_NAME,

    async fetch(): Promise<NormalizedTrend[]> {
      const out: NormalizedTrend[] = [];
      let units = 0;
      let attempted = 0;
      let failed = 0;
      let refusals = 0;

      const planned = terms.slice(0, maxSearches);
      if (planned.length < terms.length) {
        log(`search budget truncated config: running ${planned.length}/${terms.length} queries (cap ${maxSearches})`);
      }

      const publishedAfter = new Date(now().getTime() - RECENT_DAYS * 86400_000).toISOString();
      const tags = new Map<string, TagTally>();
      // Two queries can return the same video ("house tour" and "first time
      // home buyer tips" overlap constantly). It counts toward each query's
      // search_term row — that is what each query saw — but a hashtag on it is
      // ONE video's endorsement, not two, so the tally dedupes by video id.
      const talliedVideos = new Set<string>();

      for (const { term, segment } of planned) {
        // One query is two calls; both are counted as one attempt so a failure
        // on either reads as "this query yielded nothing".
        attempted++;
        let ids: string[] = [];
        try {
          const searchUrl = `${SEARCH_URL}?part=id&type=video&q=${encodeURIComponent(term)}` +
            `&order=viewCount&publishedAfter=${encodeURIComponent(publishedAfter)}` +
            `&maxResults=${RESULTS_PER_SEARCH}&regionCode=${encodeURIComponent(region)}` +
            `&relevanceLanguage=en&key=${encodeURIComponent(opts.apiKey)}`;
          const res = await doFetch(searchUrl);
          units += SEARCH_UNITS;
          if (!res.ok) {
            failed++;
            if (isRefusal(res.status)) {
              refusals++;
              log(`"${term}" search HTTP ${res.status} — CREDENTIALS OR QUOTA REJECTED, not an empty result: ${await refusalReason(res)}`);
            } else {
              log(`"${term}" search HTTP ${res.status} — skipping: ${await refusalReason(res)}`);
            }
            continue;
          }
          const payload = await res.json() as { items?: Array<{ id?: { videoId?: string } }> };
          ids = (payload.items ?? []).map((i) => i?.id?.videoId).filter((v): v is string => typeof v === "string" && v.length > 0);
        } catch (e) {
          units += SEARCH_UNITS;
          failed++;
          log(`"${term}" search failed — skipping`, e instanceof Error ? e.message : e);
          continue;
        }

        // A query that genuinely matched nothing this week is a real answer,
        // not a failure — it must not trip the all-failed backstop.
        if (ids.length === 0) {
          log(`"${term}" returned no videos published in the last ${RECENT_DAYS} days`);
          continue;
        }

        let videos: Array<{ id?: string; statistics?: { viewCount?: unknown }; snippet?: { title?: string; description?: string } }> = [];
        try {
          const videosUrl = `${VIDEOS_URL}?part=statistics,snippet&id=${encodeURIComponent(ids.join(","))}` +
            `&key=${encodeURIComponent(opts.apiKey)}`;
          const res = await doFetch(videosUrl);
          units += VIDEOS_UNITS;
          if (!res.ok) {
            failed++;
            if (isRefusal(res.status)) refusals++;
            log(`"${term}" videos HTTP ${res.status} — skipping: ${await refusalReason(res)}`);
            continue;
          }
          const payload = await res.json() as { items?: typeof videos };
          videos = payload.items ?? [];
        } catch (e) {
          units += VIDEOS_UNITS;
          failed++;
          log(`"${term}" videos failed — skipping`, e instanceof Error ? e.message : e);
          continue;
        }

        let sumViews = 0;
        const sampleIds: string[] = [];
        for (const v of videos) {
          const views = num(v.statistics?.viewCount);
          sumViews += views;
          if (v.id) sampleIds.push(v.id);
          if (v.id && talliedVideos.has(v.id)) continue;
          if (v.id) talliedVideos.add(v.id);
          const seen = extractHashtags(`${v.snippet?.title ?? ""}\n${v.snippet?.description ?? ""}`);
          for (const tag of seen) {
            const prior = tags.get(tag);
            if (prior) { prior.videos++; prior.views += views; }
            else tags.set(tag, { tag, videos: 1, views });
          }
        }

        out.push({
          platform: "youtube",
          type: "search_term",
          source: SOURCE_NAME,
          normalizedName: normalizeName(term),
          displayName: term,
          externalUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(term)}`,
          region,
          views: sumViews,
          postCount: videos.length,
          // Trimmed — never the raw video objects, `trend_observations.raw` is append-only history.
          raw: { source: SOURCE_NAME, term, segment, videosSampled: videos.length, sumViews, sampleIds: sampleIds.slice(0, 10), publishedAfter },
        });
      }

      for (const t of tags.values()) {
        if (t.videos < MIN_VIDEOS_PER_TAG) continue;
        out.push({
          platform: "youtube",
          type: "hashtag",
          source: SOURCE_NAME,
          normalizedName: normalizeName(t.tag),
          displayName: `#${t.tag}`,
          externalUrl: `https://www.youtube.com/hashtag/${encodeURIComponent(t.tag)}`,
          region,
          views: t.views,
          postCount: t.videos,
          raw: { source: SOURCE_NAME, tag: t.tag, videosUsing: t.videos, sumViews: t.views },
        });
      }

      // [SOURCE-HEALTH] Same two throws as the TikTok adapters, for the same
      // reason: nothing back from every call is a key or quota problem wearing
      // an empty week's clothes, and index.ts only records ok:false on a throw.
      if (out.length === 0 && refusals > 0) {
        throw new Error(
          `credentials or quota rejected on ${refusals}/${attempted} queries — ` +
          `this is a key/quota problem, NOT an empty week. Check YOUTUBE_API_KEY and the Data API quota in Google Cloud.`,
        );
      }
      if (out.length === 0 && allCallsFailed(attempted, failed)) {
        throw new Error(
          `all ${attempted} queries failed and none returned usable data — ` +
          `this is a vendor, key or quota problem, NOT an empty week. See the per-query HTTP statuses above.`,
        );
      }
      if (refusals > 0) {
        log(`WARNING: ${refusals}/${attempted} queries were refused (key or quota); returning partial results`);
      }
      log(`done: ~${units} quota units, ${out.length} trends (${out.filter((t) => t.type === "hashtag").length} hashtags)`);
      return out;
    },
  };
}
