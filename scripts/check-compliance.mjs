// scripts/check-compliance.mjs
//
// Exercises the safe-defaults floor in api/_lib/compliance.js against
// known-bad phrases so a regression in the floor denylist or the scrubber's
// walker shows up before it ships. Mirrors scripts/check-index-syntax.mjs:
// Node ES module, prints OK / errors, exits 1 on failure.
//
// Does NOT depend on Supabase — the test stubs the loader by passing an
// empty `loaded` map to getComplianceForNiche, so getComplianceForNiche
// falls through to FLOOR_RULES. End-to-end DB testing is out of scope for
// this script; the human-review loop is the canonical signal that DB
// rules are doing what the reviewer intended.

import {
  getComplianceForNiche,
  buildComplianceBlock,
  scrubCompliance,
  __TEST_ONLY__,
} from "../api/_lib/compliance.js";

let failures = 0;

function assert(cond, msg) {
  if (cond) return;
  failures += 1;
  console.error("FAIL:", msg);
}

function expectRewrite(complianceForNiche, field, input, mustContain, mustNotContain) {
  const payload = { cards: [{ [field]: input }] };
  const { scrubbed, flags } = scrubCompliance(complianceForNiche, payload);
  const out = scrubbed.cards[0][field];
  assert(mustContain ? out.toLowerCase().includes(mustContain.toLowerCase()) : true,
    "expected rewrite of '" + input + "' to contain '" + mustContain + "' — got '" + out + "'");
  if (mustNotContain) {
    assert(!out.toLowerCase().includes(mustNotContain.toLowerCase()),
      "expected rewrite of '" + input + "' to NOT contain '" + mustNotContain + "' — got '" + out + "'");
  }
  assert(flags.length > 0 && flags.some(f => f.rewritten),
    "expected at least one rewritten flag for '" + input + "' — got " + JSON.stringify(flags));
}

function expectFlag(complianceForNiche, field, input) {
  const payload = { cards: [{ [field]: input }] };
  const { scrubbed, flags } = scrubCompliance(complianceForNiche, payload);
  assert(flags.length > 0, "expected at least one flag for '" + input + "' — got " + JSON.stringify(flags));
  // Flag-only rules should NOT have rewritten the text in place.
  assert(scrubbed.cards[0][field] === input,
    "flag-only rule should not have rewritten '" + input + "' — got '" + scrubbed.cards[0][field] + "'");
}

function expectClean(complianceForNiche, field, input) {
  const payload = { cards: [{ [field]: input }] };
  const { scrubbed, flags } = scrubCompliance(complianceForNiche, payload);
  assert(flags.length === 0, "expected no flags for '" + input + "' — got " + JSON.stringify(flags));
  assert(scrubbed.cards[0][field] === input, "expected text unchanged for '" + input + "' — got '" + scrubbed.cards[0][field] + "'");
}

// ── Resolve the floor bundles (loader returns {}, falls through to floor)
const reUS = getComplianceForNiche({}, "Real Estate", "US");
const wlUS = getComplianceForNiche({}, "Wellness",    "US");
const food = getComplianceForNiche({}, "Food & Recipes", "US"); // maps to wellness
const otherUS = getComplianceForNiche({}, "Fitness",   "US");
const reCA = getComplianceForNiche({}, "Real Estate", "CA");

// Sanity: real_estate + wellness resolve, fitness + non-US do not.
assert(reUS && reUS.nicheKey === "real_estate", "Real Estate (US) should resolve");
assert(wlUS && wlUS.nicheKey === "wellness",    "Wellness (US) should resolve");
assert(food && food.nicheKey === "wellness",    "Food & Recipes should resolve to wellness (per nicheCategory)");
assert(otherUS === null, "Fitness should NOT resolve in v1");
assert(reCA   === null, "Non-US locale should NOT resolve in v1");

// ── Prompt-level block sanity
const reBlock = buildComplianceBlock(reUS);
assert(reBlock.includes("FAIR HOUSING") || reBlock.includes("Fair Housing"),
  "real-estate prompt block should mention Fair Housing");
assert(reBlock.includes("compliance_note"),
  "real-estate prompt block should mention compliance_note field");
const wlBlock = buildComplianceBlock(wlUS);
assert(wlBlock.includes("FDA") || wlBlock.includes("DISEASE"),
  "wellness prompt block should mention FDA or DISEASE");
assert(buildComplianceBlock(null) === "", "out-of-scope should return empty block");

// ── REAL ESTATE rewrites
expectRewrite(reUS, "title",       "Perfect for families home in a great school district", "wide range");
expectRewrite(reUS, "description", "Charming bachelor pad with city views",                  "well-laid-out");
expectRewrite(reUS, "caption",     "In a safe neighborhood close to downtown",               "well-located");
expectRewrite(reUS, "body",        "An exclusive neighborhood with beautiful trees",         "established");

// ── REAL ESTATE flag-only (model should fix; scrub flags but doesn't rewrite)
expectFlag(reUS, "caption", "Guaranteed appreciation in this market");
expectFlag(reUS, "caption", "A risk-free investment for first-time buyers");
expectFlag(reUS, "body",    "Just close to church and excellent schools");
expectFlag(reUS, "body",    "A vibrant Christian community awaits");
expectFlag(reUS, "description", "Ideal for empty nesters looking to downsize");

// ── REAL ESTATE conservative — false-positive checks
expectClean(reUS, "caption", "This listing has appreciated steadily over the past decade.");
expectClean(reUS, "body",    "Three bedrooms, two baths, attached garage, fenced backyard.");
expectClean(reUS, "caption", "Walking distance to Cedar Park and Main Street shopping.");

// ── WELLNESS flag-only (FDA / FTC)
expectFlag(wlUS, "caption", "This protocol cures chronic fatigue in 30 days.");
expectFlag(wlUS, "body",    "Cure your insomnia with this one trick");
expectFlag(wlUS, "caption", "Doctor-recommended supplement for daily energy.");
expectFlag(wlUS, "body",    "Our clinically proven blend supports immune health.");
expectFlag(wlUS, "caption", "FDA-approved formula for joint comfort.");
expectFlag(wlUS, "body",    "This protein powder reverses diabetes naturally.");
expectFlag(wlUS, "caption", "Eliminate anxiety with our adaptogen blend.");
expectFlag(wlUS, "description", "Miracle cure for hormonal balance.");

// ── WELLNESS conservative — should NOT rewrite "treats" in food/dessert sense
expectClean(wlUS, "caption", "Healthy treats from the bakery — try these gluten-free brownies.");
expectClean(wlUS, "body",    "May help support healthy digestion and energy levels.");
expectClean(wlUS, "description", "Promotes restful sleep when used as part of an evening routine.");

// ── Path tracking — flags should record where the violation was found
{
  const payload = { cards: [{ caption: "bachelor pad", insight: "guaranteed appreciation" }] };
  const { flags } = scrubCompliance(reUS, payload);
  const havePath = flags.every(f => typeof f.path === "string" && f.path.length > 0);
  assert(havePath, "every flag should carry a path string — got " + JSON.stringify(flags));
}

// ── SKIP_KEYS — hashtags / format / platform shouldn't be scrubbed
{
  const payload = { cards: [{ hashtags: ["cures", "fdaapproved"], format: "video", platform: "TikTok" }] };
  const { flags } = scrubCompliance(wlUS, payload);
  assert(flags.length === 0, "hashtags/format/platform should be skipped — got " + JSON.stringify(flags));
}

// ── compliance_note itself should not be scrubbed (it CONTAINS the disclaimer)
{
  const payload = { cards: [{ compliance_note: "Not intended to diagnose, treat, cure, or prevent any disease." }] };
  const { flags } = scrubCompliance(wlUS, payload);
  assert(flags.length === 0, "compliance_note text should be left alone — got " + JSON.stringify(flags));
}

// ── Out-of-scope niche (Fitness) should be a no-op on the scrub
{
  const payload = { cards: [{ caption: "guaranteed appreciation and perfect for families" }] };
  const { scrubbed, flags } = scrubCompliance(otherUS, payload);
  assert(flags.length === 0, "out-of-scope niche should not flag anything");
  assert(scrubbed.cards[0].caption.includes("perfect for families"), "out-of-scope niche should not rewrite");
}

// ── FLOOR_RULES is exported for testing — sanity check it stays in shape
const floor = __TEST_ONLY__.FLOOR_RULES;
assert(floor && floor.real_estate && floor.real_estate.US && Array.isArray(floor.real_estate.US.denylist),
  "FLOOR_RULES.real_estate.US.denylist should be an array");
assert(floor.wellness && floor.wellness.US && Array.isArray(floor.wellness.US.denylist),
  "FLOOR_RULES.wellness.US.denylist should be an array");

if (failures > 0) {
  console.error("\n" + failures + " assertion(s) failed.");
  process.exit(1);
}
console.log("OK: compliance floor + scrubber passed all assertions.");
