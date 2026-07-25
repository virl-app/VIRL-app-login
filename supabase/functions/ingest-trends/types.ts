// Shared types for the trend-ingestion pipeline.
//
// This function runs on Deno (Supabase Edge Runtime) and therefore cannot
// import anything from the Node-side `api/_lib`. Everything the pipeline needs
// is re-declared here on purpose — the duplication is the price of the runtime
// split, and keeping it in one file makes the drift obvious if the canonical
// segment list ever changes.

/**
 * The nine canonical audience segments. These keys are the contract between
 * three places: `playbook_segments.segment_key`, the `niche_scores` JSON we
 * write onto `trend_items`, and the generation-side segment resolver in
 * `api/_lib/trend-context.js`. Adding a segment means updating all three.
 */
export const CANONICAL_SEGMENTS = [
  "real_estate",
  "coach",
  "creator",
  "personal_brand",
  "small_business",
  "fitness",
  "healthcare",
  "beauty",
  "hair",
] as const;

export type SegmentKey = (typeof CANONICAL_SEGMENTS)[number];

/** Mirrors the CHECK constraint on `trend_items.status`. */
export type TrendStatus = "new" | "rising" | "peaking" | "fading" | "dead";

/**
 * The normalized shape every adapter must emit. Deliberately source-agnostic:
 * adding Apify / YouTube / Pinterest later should be a one-file change that
 * implements `TrendSource` and returns these.
 */
export interface NormalizedTrend {
  platform: string;
  type: string;
  normalizedName: string;
  displayName: string;
  externalUrl?: string;
  region: string;
  rank?: number;
  views?: number;
  postCount?: number;
  raw: unknown;
}

export interface TrendSource {
  name: string;
  fetch(): Promise<NormalizedTrend[]>;
}

/** A row as it comes back from `trend_items`. */
export interface TrendItemRow {
  id: string;
  platform: string;
  type: string;
  normalized_name: string;
  display_name: string;
  region: string;
  status: TrendStatus;
  last_seen: string;
  niche_scores: Record<string, number> | null;
}

/** A row as it comes back from `trend_observations`. */
export interface ObservationRow {
  trend_item_id?: string;
  observed_at: string;
  rank: number | null;
  views: number | null;
  post_count: number | null;
}

/** Stable key for matching an adapter result to its `trend_items` row. */
export function trendKey(
  t: { platform: string; type: string; normalizedName?: string; normalized_name?: string; region: string },
): string {
  const name = t.normalizedName ?? t.normalized_name ?? "";
  return `${t.platform}|${t.type}|${name}|${t.region}`;
}
