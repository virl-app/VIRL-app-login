// Lifecycle scoring — pure functions, no I/O.
//
// Kept free of network/DB access on purpose so the transitions can be unit
// tested against synthetic observation sequences (see lifecycle.test.ts) and
// re-run in-process via the function's `?selftest=1` route.
//
// Rank semantics: LOWER is better (rank 1 beats rank 9). Many of our v1 trends
// come from EnsembleData hashtag aggregates that carry no rank at all, so every
// rank comparison has to tolerate null and fall back to view movement.

import type { ObservationRow, TrendStatus } from "./types.ts";

export interface LifecycleThresholds {
  /** A trend absent this many days is dead. */
  deadAfterDays: number;
  /** Views must grow by at least this ratio to count as "growing" (noise floor). */
  viewGrowthRatio: number;
  /** Latest views at or above this count as "high views" for the peaking test. */
  highViews: number;
  /** |Δrank| at or below this counts as "plateaued". */
  plateauRankTolerance: number;
}

export const DEFAULT_THRESHOLDS: LifecycleThresholds = {
  deadAfterDays: 14,
  viewGrowthRatio: 1.05,
  highViews: 1_000_000,
  plateauRankTolerance: 1,
};

export interface LifecycleInput {
  /** Observations for this trend, chronological ASCENDING (oldest → newest). */
  observations: ObservationRow[];
  /** Did this trend appear in the run that just completed? */
  presentInLatestRun: boolean;
  /** `trend_items.last_seen` for this trend. */
  lastSeen: string | Date;
  /** Wall clock for the run. */
  now: Date;
  /**
   * True when EVERY adapter returned zero items. The brief's fail-soft rule:
   * one bad run must never cascade the whole table to fading/dead, so when this
   * is set we freeze the status of anything we didn't positively observe.
   */
  emptyRun: boolean;
  /** Existing `trend_items.status`, used as the conservative fallback. */
  currentStatus?: TrendStatus;
  thresholds?: Partial<LifecycleThresholds>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(from: string | Date, to: Date): number {
  const t = typeof from === "string" ? Date.parse(from) : from.getTime();
  if (!Number.isFinite(t)) return 0;
  return (to.getTime() - t) / DAY_MS;
}

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Did the trend improve between two consecutive observations? */
export function isImproving(
  prev: ObservationRow,
  cur: ObservationRow,
  th: LifecycleThresholds,
): boolean {
  const pr = num(prev.rank), cr = num(cur.rank);
  // Rank is the stronger signal when both sides have it.
  if (pr !== null && cr !== null && cr < pr) return true;

  const pv = num(prev.views), cv = num(cur.views);
  if (pv !== null && cv !== null && pv > 0) return cv >= pv * th.viewGrowthRatio;

  return false;
}

/** Did rank get worse between two consecutive observations? */
function isRankFalling(prev: ObservationRow, cur: ObservationRow): boolean {
  const pr = num(prev.rank), cr = num(cur.rank);
  return pr !== null && cr !== null && cr > pr;
}

/** Rank barely moved — the signature of a plateau. */
function isPlateau(
  prev: ObservationRow,
  cur: ObservationRow,
  th: LifecycleThresholds,
): boolean {
  const pr = num(prev.rank), cr = num(cur.rank);
  // With no rank on either side we treat "views stopped growing" as a plateau,
  // which is the only signal a rank-less hashtag aggregate gives us.
  if (pr === null || cr === null) return !isImproving(prev, cur, th);
  return Math.abs(cr - pr) <= th.plateauRankTolerance;
}

/** Rank fell on two consecutive transitions (needs 3 observations). */
export function isRankFallingTwice(obs: ObservationRow[]): boolean {
  if (obs.length < 3) return false;
  const [a, b, c] = obs.slice(-3);
  return isRankFalling(a, b) && isRankFalling(b, c);
}

/**
 * Compute the status a trend should hold after this run.
 *
 * Order matters: the terminal/negative states are checked before the positive
 * ones so a trend that vanished can't be scored "rising" off stale history.
 */
export function scoreLifecycle(input: LifecycleInput): TrendStatus {
  const th = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const { observations, presentInLatestRun, emptyRun, currentStatus, now, lastSeen } = input;

  // ── Empty-run guard ──────────────────────────────────────────────────────
  // If the run produced nothing, absence proves nothing about the trend — it
  // proves something about the adapter. Freeze anything we didn't observe.
  if (emptyRun && !presentInLatestRun) return currentStatus ?? "new";

  if (!emptyRun) {
    if (daysBetween(lastSeen, now) >= th.deadAfterDays) return "dead";
    if (!presentInLatestRun) return "fading";
  }

  // First-ever sighting: nothing to compare against yet.
  if (observations.length < 2) return "new";

  const recent = observations.slice(-3);
  const cur = recent[recent.length - 1];
  const prev = recent[recent.length - 2];

  if (!emptyRun && isRankFallingTwice(recent)) return "fading";
  if (isImproving(prev, cur, th)) return "rising";

  const views = num(cur.views);
  if (views !== null && views >= th.highViews && isPlateau(prev, cur, th)) return "peaking";

  // Nothing conclusive — hold the existing status rather than inventing one.
  // "dead" is never held here; a trend we just observed is by definition alive.
  return currentStatus && currentStatus !== "dead" ? currentStatus : "new";
}
