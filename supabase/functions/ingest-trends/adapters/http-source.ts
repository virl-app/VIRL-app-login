// Vendor-agnostic TikTok hashtag-posts adapter, configured entirely from env.
//
// WHY THIS SHAPE, AND WHAT IT DOES NOT CLAIM
//
// EnsembleData's floor is $100/month for a workload that spends roughly 190
// units of it. The pay-as-you-go providers that now dominate this category
// (ScrapeCreators, SociaVault, SocialCrawl, the Apify TikTok actors) charge
// per call with no subscription, which is the right shape for this volume.
//
// They also differ from each other in exactly three boring ways — the URL, how
// the token is presented, and the JSON envelope — and are substantially the
// same in the way that matters, because all of them proxy the same upstream
// TikTok post objects. So rather than commit to one vendor's client before an
// account exists, this adapter parameterizes the three differences and shares
// the post parsing (see tiktok-normalize.ts).
//
// IMPORTANT — this has NOT been run against a live provider. Every provider
// documentation site was unreachable from the environment this was written in,
// so the envelope candidates in `extractPosts` are informed guesses drawn from
// the shapes this codebase has already seen, not from a vendor's schema. The
// response parsing is deliberately defensive for that reason, and
// `?sourcetest=1` in index.ts exists to prove or disprove it against a real
// endpoint in one request before this is scheduled. Treat it as unverified
// until that route returns posts.
//
// CONFIG (all via env on the edge function):
//
//   TREND_HTTP_URL     Required. URL template. `{tag}` is replaced with the
//                      url-encoded hashtag; `{token}` with the token, for
//                      providers that authenticate by query string.
//                        e.g. https://api.example.com/tiktok/hashtag?name={tag}
//                        e.g. https://api.example.com/v1/hashtag/{tag}?key={token}
//   TREND_HTTP_TOKEN   Required. The API key.
//   TREND_HTTP_HEADER  Optional. Header name to send the token in, e.g.
//                      "x-api-key" or "Authorization". Omit for query-string auth.
//   TREND_HTTP_PREFIX  Optional. Prefix for the header value, e.g. "Bearer ".
//                      Defaults to empty.
//   TREND_HTTP_NAME    Optional. Source label recorded on rows and in the run
//                      summary. Defaults to "http-source".
//   TREND_HTTP_MAX     Optional. Hard ceiling on billable calls per run.
//                      Defaults to 25.

import type { NormalizedTrend, TrendSource } from "../types.ts";
import {
  extractPosts,
  foldPosts,
  isRefusal,
  normalizeName,
  type SoundTally,
} from "./tiktok-normalize.ts";

/** A sound must appear on at least this many sampled posts to count. */
const MIN_POSTS_PER_SOUND = 2;

/** Default ceiling on billable calls per run. */
export const DEFAULT_MAX_CALLS = 25;

export interface HttpSourceOptions {
  urlTemplate: string;
  token: string;
  header?: string;
  prefix?: string;
  name?: string;
  region?: string;
  hashtags: Array<{ tag: string; segment: string }>;
  maxCalls?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string, extra?: unknown) => void;
}

/** Substitute {tag} / {token} into the configured template. */
export function buildUrl(template: string, tag: string, token: string): string {
  return template
    .replace(/\{tag\}/g, encodeURIComponent(tag))
    .replace(/\{token\}/g, encodeURIComponent(token));
}

/**
 * Read config out of the environment, returning null when it isn't configured
 * at all. Null means "this source is off", which is a normal state — it is NOT
 * an error, and index.ts treats it as such.
 *
 * A partially-configured source (URL but no token) IS an error and says so,
 * because that is a deploy mistake that would otherwise present as a quiet
 * empty run — the failure mode this pipeline keeps relearning.
 */
export function httpSourceConfigFromEnv(
  env: (k: string) => string | undefined,
): { urlTemplate: string; token: string; header?: string; prefix?: string; name: string; maxCalls: number } | null {
  const urlTemplate = env("TREND_HTTP_URL") ?? "";
  const token = env("TREND_HTTP_TOKEN") ?? "";
  if (!urlTemplate && !token) return null;
  if (!urlTemplate || !token) {
    throw new Error(
      "http-source is half-configured: TREND_HTTP_URL and TREND_HTTP_TOKEN must both be set (or both absent).",
    );
  }
  const maxRaw = Number(env("TREND_HTTP_MAX"));
  return {
    urlTemplate,
    token,
    header: env("TREND_HTTP_HEADER") || undefined,
    prefix: env("TREND_HTTP_PREFIX") || undefined,
    name: env("TREND_HTTP_NAME") || "http-source",
    maxCalls: Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : DEFAULT_MAX_CALLS,
  };
}

export function httpTrendSource(opts: HttpSourceOptions): TrendSource {
  const name = opts.name ?? "http-source";
  const region = opts.region ?? "US";
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((m: string, e?: unknown) => console.log(`[${name}] ${m}`, e ?? ""));

  return {
    name,

    async fetch(): Promise<NormalizedTrend[]> {
      const out: NormalizedTrend[] = [];
      const sounds = new Map<string, SoundTally>();
      let calls = 0;
      let refusals = 0;
      let attempted = 0;
      let emptyPayloads = 0;

      const planned = opts.hashtags.slice(0, maxCalls);
      if (planned.length < opts.hashtags.length) {
        log(`call budget truncated config: running ${planned.length}/${opts.hashtags.length} hashtags (cap ${maxCalls})`);
      }

      const headers: Record<string, string> = { accept: "application/json" };
      if (opts.header) headers[opts.header] = `${opts.prefix ?? ""}${opts.token}`;

      for (const { tag, segment } of planned) {
        if (calls >= maxCalls) {
          log(`call budget exhausted at ${calls}; stopping before #${tag}`);
          break;
        }

        const url = buildUrl(opts.urlTemplate, tag, opts.token);
        let payload: unknown;
        try {
          attempted++;
          const res = await doFetch(url, { headers });
          calls++;
          if (!res.ok) {
            if (isRefusal(res.status)) {
              refusals++;
              log(`#${tag} HTTP ${res.status} — CREDENTIALS OR QUOTA REJECTED, not an empty result`);
            } else {
              log(`#${tag} HTTP ${res.status} — skipping`);
            }
            continue;
          }
          payload = await res.json();
        } catch (e) {
          calls++;
          log(`#${tag} fetch failed — skipping`, e instanceof Error ? e.message : e);
          continue;
        }

        const posts = extractPosts(payload);
        if (posts.length === 0) {
          emptyPayloads++;
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
          raw: { source: name, tag, segment, postsSampled: posts.length, sumPlays, samplePostIds },
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
          raw: { source: name, musicId: s.id, title: s.title, author: s.author, postsUsing: s.posts, sumPlays: s.plays },
        });
      }

      // Credentials rejected on every call is a billing problem wearing an
      // empty run's clothes. Throw so index.ts records ok:false with a reason.
      if (out.length === 0 && refusals > 0) {
        throw new Error(
          `credentials or quota rejected on ${refusals}/${attempted} calls — ` +
          `billing/token problem, NOT an empty week. Check the provider plan and TREND_HTTP_TOKEN.`,
        );
      }

      // Every call succeeded and every payload parsed to zero posts. For a
      // brand-new provider that is far more likely to mean the envelope isn't
      // in extractPosts' candidate list than that TikTok has gone quiet across
      // 22 hashtags — so say the likely cause rather than reporting silence.
      if (out.length === 0 && emptyPayloads === attempted && attempted > 0) {
        throw new Error(
          `all ${attempted} responses parsed to zero posts. The provider replied ` +
          `successfully, so this is most likely an UNRECOGNIZED RESPONSE ENVELOPE, not an empty week. ` +
          `Run ?sourcetest=1 to see the raw keys and add the envelope path to extractPosts().`,
        );
      }

      if (refusals > 0) {
        log(`WARNING: ${refusals}/${attempted} calls were refused (auth or quota); returning partial results`);
      }
      log(`done: ${calls} calls, ${out.length} trends (${out.filter((t) => t.type === "sound").length} sounds)`);
      return out;
    },
  };
}
