// Shared TikTok post normalization, used by every adapter that reads a
// TikTok-derived posts feed.
//
// Why this is shared rather than copied. Every commercial provider in this
// category — EnsembleData, ScrapeCreators, SociaVault, SocialCrawl, the Apify
// TikTok actors — is ultimately proxying the same upstream TikTok payloads.
// The ENVELOPE differs per vendor (`data.posts` vs `posts` vs `aweme_list`);
// the POST OBJECT inside it is substantially the same shape, mixing camelCase
// and snake_case depending on which TikTok response the vendor captured. So
// the envelope is what an adapter must know about, and the post parsing is
// what every adapter can share.
//
// That split is what makes swapping vendors a one-file change rather than a
// rewrite — which is the property `types.ts` promised with the `TrendSource`
// interface and which had never actually been exercised until the second
// adapter arrived.
//
// The path-probing style is inherited from the original EnsembleData adapter
// and kept deliberately: pin to one field name and a silent upstream change
// produces zero trends and a healthy-looking run, which is the exact class of
// failure this pipeline has already been bitten by.

/** Walk a dotted path, returning undefined rather than throwing. */
export function dig(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  );
}

/** First path that yields a finite number, coercing numeric strings. */
export function firstNumber(obj: unknown, paths: string[]): number | undefined {
  for (const p of paths) {
    const v = dig(obj, p);
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

/** First path that yields a non-empty string, coercing numbers. */
export function firstString(obj: unknown, paths: string[]): string | undefined {
  for (const p of paths) {
    const v = dig(obj, p);
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/**
 * Pull the post array out of whichever envelope we got. The candidate list
 * covers the shapes seen across vendors; an unknown vendor that nests
 * differently is the one thing an adapter may need to add to.
 */
export function extractPosts(payload: unknown): unknown[] {
  const candidates = [
    "data.posts", "data", "posts", "data.aweme_list", "aweme_list",
    // Additional envelopes used by the pay-as-you-go providers.
    "data.items", "items", "result.posts", "result", "videos", "data.videos",
  ];
  for (const p of candidates) {
    const v = dig(payload, p);
    if (Array.isArray(v)) return v;
  }
  return [];
}

export const PLAY_PATHS = [
  "statistics.play_count",
  "stats.playCount",
  "play_count",
  "playCount",
  "aweme_info.statistics.play_count",
  "view_count",
];

export const MUSIC_ID_PATHS = ["music.id", "music.mid", "added_sound_music_info.id", "music.id_str", "music_id"];
export const MUSIC_TITLE_PATHS = ["music.title", "added_sound_music_info.title", "music.name", "music_title"];
export const MUSIC_AUTHOR_PATHS = ["music.author", "music.authorName", "added_sound_music_info.author"];
export const POST_ID_PATHS = ["aweme_id", "id", "aweme_info.aweme_id", "video_id"];

/** Lowercase + strip anything that isn't alphanumeric. Stable upsert key. */
export function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Running tally for one sound across every hashtag sampled in a run. */
export interface SoundTally {
  id: string;
  title: string;
  author?: string;
  posts: number;
  plays: number;
}

/**
 * Fold one hashtag's posts into the cross-hashtag sound map, returning the
 * per-hashtag aggregates.
 *
 * Sounds accumulate ACROSS hashtags on purpose: a sound trending in both
 * #realtorsoftiktok and #justlisted is one trend, not two. The caller owns
 * the map so it survives the whole run.
 */
export function foldPosts(
  posts: unknown[],
  sounds: Map<string, SoundTally>,
): { sumPlays: number; samplePostIds: string[] } {
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

  return { sumPlays, samplePostIds };
}

/**
 * HTTP statuses that mean "the vendor refused us", as distinct from "the
 * vendor had nothing". 401/403 credentials, 402 payment required (the shape a
 * lapsed plan takes), 429 quota exhausted.
 *
 * Shared because every adapter needs the same distinction and getting it wrong
 * is what let a billing lapse read as a quiet week for nine days.
 */
export function isRefusal(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429;
}
