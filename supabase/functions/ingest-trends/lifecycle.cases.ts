// Shared lifecycle test cases.
//
// Imported by BOTH lifecycle.test.ts (`deno test`) and the function's
// `?selftest=1` route, so the assertions that run in CI and the assertions that
// run inside the deployed Deno runtime can never drift apart.

import type { LifecycleInput } from "./lifecycle.ts";
import type { TrendStatus } from "./types.ts";

const NOW = new Date("2026-07-24T10:00:00Z");

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** observed_at values only matter for ordering; scoring reads rank/views. */
function obs(
  rank: number | null,
  views: number | null,
  ageDays = 0,
): { observed_at: string; rank: number | null; views: number | null; post_count: number | null } {
  return { observed_at: daysAgo(ageDays), rank, views, post_count: null };
}

export interface LifecycleCase {
  name: string;
  input: LifecycleInput;
  expected: TrendStatus;
}

export const LIFECYCLE_CASES: LifecycleCase[] = [
  {
    name: "first sighting → new",
    input: {
      observations: [obs(null, 50_000)],
      presentInLatestRun: true,
      lastSeen: daysAgo(0),
      now: NOW,
      emptyRun: false,
    },
    expected: "new",
  },
  {
    name: "views growing past the noise floor → rising",
    input: {
      observations: [obs(null, 100_000, 3), obs(null, 200_000, 0)],
      presentInLatestRun: true,
      lastSeen: daysAgo(0),
      now: NOW,
      emptyRun: false,
      currentStatus: "new",
    },
    expected: "rising",
  },
  {
    name: "rank improving → rising",
    input: {
      observations: [obs(9, null, 3), obs(4, null, 0)],
      presentInLatestRun: true,
      lastSeen: daysAgo(0),
      now: NOW,
      emptyRun: false,
      currentStatus: "new",
    },
    expected: "rising",
  },
  {
    name: "high views + rank plateaued → peaking",
    input: {
      observations: [obs(3, 5_000_000, 3), obs(3, 5_010_000, 0)],
      presentInLatestRun: true,
      lastSeen: daysAgo(0),
      now: NOW,
      emptyRun: false,
      currentStatus: "rising",
    },
    expected: "peaking",
  },
  {
    name: "rank falling two runs straight → fading",
    input: {
      observations: [obs(2, 900_000, 6), obs(5, 880_000, 3), obs(9, 850_000, 0)],
      presentInLatestRun: true,
      lastSeen: daysAgo(0),
      now: NOW,
      emptyRun: false,
      currentStatus: "peaking",
    },
    expected: "fading",
  },
  {
    name: "absent from the latest run → fading",
    input: {
      observations: [obs(4, 500_000, 6), obs(4, 520_000, 3)],
      presentInLatestRun: false,
      lastSeen: daysAgo(3),
      now: NOW,
      emptyRun: false,
      currentStatus: "peaking",
    },
    expected: "fading",
  },
  {
    name: "absent 14+ days → dead",
    input: {
      observations: [obs(4, 500_000, 20)],
      presentInLatestRun: false,
      lastSeen: daysAgo(20),
      now: NOW,
      emptyRun: false,
      currentStatus: "fading",
    },
    expected: "dead",
  },
  {
    name: "EMPTY RUN GUARD: stale trend is frozen, not killed",
    input: {
      observations: [obs(4, 500_000, 20)],
      presentInLatestRun: false,
      lastSeen: daysAgo(20),
      now: NOW,
      emptyRun: true,
      currentStatus: "rising",
    },
    expected: "rising",
  },
  {
    name: "EMPTY RUN GUARD: peaking trend is not demoted to fading",
    input: {
      observations: [obs(2, 3_000_000, 4), obs(2, 3_000_000, 1)],
      presentInLatestRun: false,
      lastSeen: daysAgo(1),
      now: NOW,
      emptyRun: true,
      currentStatus: "peaking",
    },
    expected: "peaking",
  },
  {
    name: "flat and low-volume → holds existing status",
    input: {
      observations: [obs(null, 1_000, 3), obs(null, 1_010, 0)],
      presentInLatestRun: true,
      lastSeen: daysAgo(0),
      now: NOW,
      emptyRun: false,
      currentStatus: "rising",
    },
    expected: "rising",
  },
  {
    name: "a trend observed this run is never resurrected as dead",
    input: {
      observations: [obs(null, 2_000, 3), obs(null, 2_010, 0)],
      presentInLatestRun: true,
      lastSeen: daysAgo(0),
      now: NOW,
      emptyRun: false,
      currentStatus: "dead",
    },
    expected: "new",
  },
];
