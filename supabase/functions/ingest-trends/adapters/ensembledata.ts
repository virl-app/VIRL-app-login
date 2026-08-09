// EnsembleData adapter.
//
// No longer the only source: `http-source.ts` is a vendor-agnostic adapter for
// the pay-as-you-go providers, and this one stays behind its token check so
// re-enabling EnsembleData is a single env var rather than a revert. The
// original header promised that additional sources would "drop in as one-file
// changes later" — that promise came due, and the post parsing this file used
// to own now lives in `tiktok-normalize.ts` where every adapter shares it.
//
// Budget: the free tier allowed 50 units/day and one hashtag call costs 1 unit.
// We hard-cap at MAX_UNITS below and log when the config list is truncated, so
// a growing hashtag list can never silently blow the quota. Paid tiers start at
// $100/month, which is why this is no longer the default.

import type { NormalizedTrend, TrendSource } from "../types.ts";
import { HASHTAG_CONFIG } from "./hashtags.ts";
import {
  extractPosts,
  foldPosts,
  isRefusal,
  normalizeName,
  type SoundTally,
} from "./tiktok-normalize.ts";

const API_BASE = "https://ensembledata.com/apis/tt/hashtag/posts";

/** Hard ceiling on billable calls per run. Brief allows ~40 of the 50/day. */
export const MAX_UNITS = 40;

/** A sound must appear on at least this many sampled posts to count as a trend. */
const MIN_POSTS_PER_SOUND = 2;

export { HASHTAG_CONFIG, normalizeName };

export interface EnsembleOptions {
  token: string;
  region?: string;
  hashtags?: Array<{ tag: string; segment: string }>;
  maxUnits?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  log?: (msg: string, extra?: unknown) => void;
}

export function ensembleDataSource(opts: EnsembleOptions): TrendSource {
  const region = opts.region ?? "US";
  const hashtags = opts.hashtags ?? HASHTAG_CONFIG;
  const maxUnits = opts.maxUnits ?? MAX_UNITS;
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((m: string, e?: unknown) => console.log(`[ensembledata] ${m}`, e ?? ""));

  return {
    name: "ensembledata",

    async fetch(): Promise<NormalizedTrend[]> {
      const out: NormalizedTrend[] = [];
      let units = 0;
      // [SOURCE-HEALTH] "The vendor refused us" and "the vendor had nothing"
      // are opposite facts that used to produce identical output. Every
      // non-2xx was logged and skipped, so an expired plan turned all 22
      // hashtags into skips, returned [], and took index.ts's fail-soft empty
      // branch — which reports the run healthy, writes nothing, and returns
      // 200. The run summary then said `{ ok: true, count: 0 }` for an adapter
      // that was being rejected on every single call, and `keys.ensemble:
      // true` because a stale token string is still a string.
      //
      // That is the exact failure this codebase already learned about the hard
      // way: observable in a log line, invisible everywhere a human looks.
      // Counting the refusals separately is what lets the summary tell the
      // truth about which one happened.
      let authRefusals = 0;
      let attempted = 0;

      // Truncate up front and say so, rather than discovering the cap mid-run.
      const planned = hashtags.slice(0, maxUnits);
      if (planned.length < hashtags.length) {
        log(
          `unit budget truncated config: running ${planned.length}/${hashtags.length} hashtags (cap ${maxUnits})`,
        );
      }

      // Sounds are aggregated ACROSS hashtags — a sound trending in both
      // #realtorsoftiktok and #justlisted is one trend, not two.
      const sounds = new Map<string, SoundTally>();

      for (const { tag, segment } of planned) {
        if (units >= maxUnits) {
          log(`unit budget exhausted at ${units}; stopping before #${tag}`);
          break;
        }

        const url = `${API_BASE}?name=${encodeURIComponent(tag)}&cursor=0&token=${encodeURIComponent(opts.token)}`;

        let payload: unknown;
        try {
          attempted++;
          const res = await doFetch(url);
          units++; // count the unit the moment the request is billable
          if (!res.ok) {
            // 401/403 = credentials rejected. 402 = payment required (the
            // shape a lapsed plan takes). 429 = quota exhausted. None of
            // these say anything about whether trends exist.
            if (isRefusal(res.status)) {
              authRefusals++;
              log(`#${tag} HTTP ${res.status} — CREDENTIALS OR QUOTA REJECTED, not an empty result`);
            } else {
              log(`#${tag} HTTP ${res.status} — skipping`);
            }
            continue;
          }
          payload = await res.json();
        } catch (e) {
          units++;
          log(`#${tag} fetch failed — skipping`, e instanceof Error ? e.message : e);
          continue;
        }

        const posts = extractPosts(payload);
        if (posts.length === 0) {
          log(`#${tag} returned no posts`);
          continue;
        }

        const { sumPlays, samplePostIds } = foldPosts(posts, sounds);

        out.push({
          platform: "tiktok",
          type: "hashtag",
          normalizedName: normalizeName(tag),
          displayName: `#${tag}`,
          externalUrl: `https://www.tiktok.com/tag/${encodeURIComponent(tag)}`,
          region,
          views: sumPlays,
          postCount: posts.length,
          // Trimmed payload — never store the raw post array, it is enormous
          // and `trend_observations.raw` is append-only history.
          raw: { source: "ensembledata", tag, segment, postsSampled: posts.length, sumPlays, samplePostIds },
        });
      }

      for (const s of sounds.values()) {
        if (s.posts < MIN_POSTS_PER_SOUND) continue;
        out.push({
          platform: "tiktok",
          type: "sound",
          normalizedName: normalizeName(`music${s.id}`),
          displayName: s.author ? `${s.title} — ${s.author}` : s.title,
          externalUrl: `https://www.tiktok.com/music/x-${encodeURIComponent(s.id)}`,
          region,
          views: s.plays,
          postCount: s.posts,
          raw: { source: "ensembledata", musicId: s.id, title: s.title, author: s.author, postsUsing: s.posts, sumPlays: s.plays },
        });
      }

      // [SOURCE-HEALTH] Throw rather than return []. index.ts already catches
      // an adapter throw and records `{ ok: false, error }` in sourceReport —
      // that channel existed and this condition simply never used it. Only
      // when NOTHING came back: a run that got partial data is still a useful
      // run, and discarding it to raise an alarm would trade real trends for
      // a louder log line.
      if (out.length === 0 && authRefusals > 0) {
        throw new Error(
          `credentials or quota rejected on ${authRefusals}/${attempted} calls — ` +
          `this is a billing/token problem, NOT an empty week. Check the EnsembleData plan and ENSEMBLE_TOKEN.`,
        );
      }
      if (authRefusals > 0) {
        log(`WARNING: ${authRefusals}/${attempted} calls were refused (auth or quota); returning partial results`);
      }
      log(`done: ${units} units, ${out.length} trends (${out.filter((t) => t.type === "sound").length} sounds)`);
      return out;
    },
  };
}
