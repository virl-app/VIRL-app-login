// EnsembleData adapter — the PRIMARY (and only) v1 trend source.
//
// Deliberately NOT building an Apify adapter in v1. The `TrendSource` interface
// exists so additional sources (Apify Explore, YouTube API, Pinterest API) drop
// in as one-file changes later.
//
// Budget: the free tier allows 50 units/day and one hashtag call costs 1 unit.
// We hard-cap at MAX_UNITS below and log when the config list is truncated, so
// a growing hashtag list can never silently blow the quota.

import type { NormalizedTrend, TrendSource } from "../types.ts";

const API_BASE = "https://ensembledata.com/apis/tt/hashtag/posts";

/** Hard ceiling on billable calls per run. Brief allows ~40 of the 50/day. */
export const MAX_UNITS = 40;

/** A sound must appear on at least this many sampled posts to count as a trend. */
const MIN_POSTS_PER_SOUND = 2;

/**
 * Seed hashtag list, attributed to the segment it feeds. Real estate is the
 * launch segment so it gets the deepest coverage; every other segment gets 1–2
 * probes to keep niche_scores from being a real-estate monoculture.
 * 22 tags = 22 units, comfortably under MAX_UNITS.
 */
export const HASHTAG_CONFIG: Array<{ tag: string; segment: string }> = [
  { tag: "realtorsoftiktok", segment: "real_estate" },
  { tag: "realestatetips", segment: "real_estate" },
  { tag: "listingtour", segment: "real_estate" },
  { tag: "openhouse", segment: "real_estate" },
  { tag: "firsttimehomebuyer", segment: "real_estate" },
  { tag: "justlisted", segment: "real_estate" },
  { tag: "lifecoach", segment: "coach" },
  { tag: "businesscoach", segment: "coach" },
  { tag: "contentcreator", segment: "creator" },
  { tag: "creatortips", segment: "creator" },
  { tag: "personalbrand", segment: "personal_brand" },
  { tag: "thoughtleadership", segment: "personal_brand" },
  { tag: "smallbusinesscheck", segment: "small_business" },
  { tag: "smallbusinessowner", segment: "small_business" },
  { tag: "fittok", segment: "fitness" },
  { tag: "personaltrainer", segment: "fitness" },
  { tag: "doctorsoftiktok", segment: "healthcare" },
  { tag: "nursesoftiktok", segment: "healthcare" },
  { tag: "beautytok", segment: "beauty" },
  { tag: "estheticiantok", segment: "beauty" },
  { tag: "hairstylist", segment: "hair" },
  { tag: "hairtok", segment: "hair" },
];

// ── defensive response parsing ─────────────────────────────────────────────
// EnsembleData's envelope has shifted shape between versions and the post
// objects mix camelCase and snake_case depending on which TikTok payload they
// proxied. Rather than pin to one shape and break on a silent upstream change,
// probe a list of candidate paths and take the first hit.

function dig(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  );
}

function firstNumber(obj: unknown, paths: string[]): number | undefined {
  for (const p of paths) {
    const v = dig(obj, p);
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function firstString(obj: unknown, paths: string[]): string | undefined {
  for (const p of paths) {
    const v = dig(obj, p);
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/** Pull the post array out of whichever envelope we got. */
function extractPosts(payload: unknown): unknown[] {
  const candidates = ["data.posts", "data", "posts", "data.aweme_list", "aweme_list"];
  for (const p of candidates) {
    const v = dig(payload, p);
    if (Array.isArray(v)) return v;
  }
  return [];
}

const PLAY_PATHS = [
  "statistics.play_count",
  "stats.playCount",
  "play_count",
  "aweme_info.statistics.play_count",
];

const MUSIC_ID_PATHS = ["music.id", "music.mid", "added_sound_music_info.id", "music.id_str"];
const MUSIC_TITLE_PATHS = ["music.title", "added_sound_music_info.title"];
const MUSIC_AUTHOR_PATHS = ["music.author", "music.authorName", "added_sound_music_info.author"];
const POST_ID_PATHS = ["aweme_id", "id", "aweme_info.aweme_id"];

/** Lowercase + strip anything that isn't alphanumeric. Stable upsert key. */
export function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

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

      // Truncate up front and say so, rather than discovering the cap mid-run.
      const planned = hashtags.slice(0, maxUnits);
      if (planned.length < hashtags.length) {
        log(
          `unit budget truncated config: running ${planned.length}/${hashtags.length} hashtags (cap ${maxUnits})`,
        );
      }

      // Sounds are aggregated ACROSS hashtags — a sound trending in both
      // #realtorsoftiktok and #justlisted is one trend, not two.
      const sounds = new Map<
        string,
        { id: string; title: string; author?: string; posts: number; plays: number }
      >();

      for (const { tag, segment } of planned) {
        if (units >= maxUnits) {
          log(`unit budget exhausted at ${units}; stopping before #${tag}`);
          break;
        }

        const url = `${API_BASE}?name=${encodeURIComponent(tag)}&cursor=0&token=${encodeURIComponent(opts.token)}`;

        let payload: unknown;
        try {
          const res = await doFetch(url);
          units++; // count the unit the moment the request is billable
          if (!res.ok) {
            log(`#${tag} HTTP ${res.status} — skipping`);
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

        let sumPlays = 0;
        const samplePostIds: string[] = [];

        for (const post of posts) {
          const plays = firstNumber(post, PLAY_PATHS) ?? 0;
          sumPlays += plays;
          if (samplePostIds.length < 3) {
            const pid = firstString(post, POST_ID_PATHS);
            if (pid) samplePostIds.push(pid);
          }

          const musicId = firstString(post, MUSIC_ID_PATHS);
          if (musicId) {
            const prior = sounds.get(musicId);
            if (prior) {
              prior.posts++;
              prior.plays += plays;
            } else {
              sounds.set(musicId, {
                id: musicId,
                title: firstString(post, MUSIC_TITLE_PATHS) ?? `Sound ${musicId}`,
                author: firstString(post, MUSIC_AUTHOR_PATHS),
                posts: 1,
                plays,
              });
            }
          }
        }

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

      log(`done: ${units} units, ${out.length} trends (${out.filter((t) => t.type === "sound").length} sounds)`);
      return out;
    },
  };
}
