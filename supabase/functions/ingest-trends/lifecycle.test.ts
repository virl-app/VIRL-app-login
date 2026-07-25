// Unit tests for lifecycle scoring.
//
//   deno test supabase/functions/ingest-trends/lifecycle.test.ts
//
// The cases live in lifecycle.cases.ts so the deployed function's `?selftest=1`
// route asserts exactly the same behavior. This file is NOT deployed with the
// function.

import { assertEquals } from "jsr:@std/assert@1";
import { scoreLifecycle, isImproving, isRankFallingTwice, DEFAULT_THRESHOLDS } from "./lifecycle.ts";
import { LIFECYCLE_CASES } from "./lifecycle.cases.ts";
import { selectForEnrichment, extractJson, PERPLEXITY_MAX_CALLS } from "./enrich.ts";

for (const c of LIFECYCLE_CASES) {
  Deno.test(`scoreLifecycle: ${c.name}`, () => {
    assertEquals(scoreLifecycle(c.input), c.expected);
  });
}

Deno.test("isImproving: rank beats views when both present", () => {
  const th = DEFAULT_THRESHOLDS;
  // Rank improved even though views dipped — rank is the stronger signal.
  assertEquals(isImproving({ observed_at: "", rank: 9, views: 100 }, { observed_at: "", rank: 2, views: 90 }, th), true);
  // Views grew but only by 1%, under the noise floor.
  assertEquals(isImproving({ observed_at: "", rank: null, views: 100 }, { observed_at: "", rank: null, views: 101 }, th), false);
});

Deno.test("isRankFallingTwice: needs three observations", () => {
  const a = { observed_at: "", rank: 2, views: null, post_count: null };
  const b = { observed_at: "", rank: 5, views: null, post_count: null };
  const c = { observed_at: "", rank: 9, views: null, post_count: null };
  assertEquals(isRankFallingTwice([a, b]), false);
  assertEquals(isRankFallingTwice([a, b, c]), true);
});

Deno.test("selectForEnrichment: respects floor, status filter and hard cap", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `t${i}`,
    displayName: `#tag${i}`,
    status: "rising" as const,
    scores: { real_estate: 0.9 },
  }));
  assertEquals(selectForEnrichment(many).length, PERPLEXITY_MAX_CALLS);

  const belowFloor = [{ id: "a", displayName: "#a", status: "rising" as const, scores: { real_estate: 0.55 } }];
  assertEquals(selectForEnrichment(belowFloor).length, 0);

  const wrongStatus = [{ id: "b", displayName: "#b", status: "fading" as const, scores: { real_estate: 0.95 } }];
  assertEquals(selectForEnrichment(wrongStatus).length, 0);
});

Deno.test("selectForEnrichment: picks the top-scoring segment", () => {
  const [picked] = selectForEnrichment([
    { id: "x", displayName: "#x", status: "new", scores: { real_estate: 0.7, fitness: 0.95 } },
  ]);
  assertEquals(picked.topSegment, "fitness");
});

Deno.test("extractJson: survives prose and code fences", () => {
  assertEquals(extractJson<{ a: number }>('```json\n{"a":1}\n```')?.a, 1);
  assertEquals(extractJson<{ a: number }>('Sure! Here you go:\n{"a":2}\nHope that helps.')?.a, 2);
  assertEquals(extractJson("not json at all"), null);
});
