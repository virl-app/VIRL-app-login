// scripts/check-composer-fields.mjs
//
// [PLATFORM-COMPOSER] Deterministic, no-network gate on the Pinterest and
// YouTube composer fields.
//
// The defect this guards against is a contract split across two files. The
// plan prompt (api/_lib/prompts.js) tells the model which fields to emit for a
// Pinterest or YouTube card; the renderer (index.html) decides which fields to
// show, count, copy and save. Nothing joins them, so a field renamed on one
// side goes silently missing on the other — which is exactly the failure the
// composer work fixed, one layer up: the composer asked for six inputs and the
// card produced one, and no test noticed because no test knew both numbers.
//
// So the assertions below check the two sides against EACH OTHER, not against
// a third copy of the list. If the prompt stops asking for `altText`, the
// renderer's row for it becomes the failure.
//
// Layout mirrors check-strategist.mjs: Node ES module, prints OK / FAIL,
// exits 1 so CI blocks.

import { dispatch } from "../api/_lib/prompts.js";
import { CREATOR_VOICE_FIELDS, VIRL_VOICE_FIELDS } from "../api/_lib/virl-persona.js";
import { readFileSync } from "node:fs";

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures += 1;
  console.error("FAIL:", msg);
}

const PROFILE = {
  name: "Dana",
  audience: "small business owners who hate posting",
  myPlatforms: ["Pinterest", "YouTube"],
  businessWebsite: "govirl.ai",
};

// The plan builder returns a two-tier systemPrompt ({shared, perUser}) so the
// cache-friendly prefix can be reused; flatten both tiers plus the user prompt
// before asserting, the same way check-strategist.mjs does.
function wholeOf(built) {
  const sp = built.systemPrompt;
  const system = (typeof sp === "string") ? sp : ((sp.shared || "") + "\n" + (sp.perUser || ""));
  return system + "\n" + (built.userPrompt || "");
}

const built = dispatch("plan", {
  platforms: ["Pinterest", "YouTube"],
  formats:   ["single_image", "video"],
  niche:     "Small Business",
  goal:      "Drive traffic to my site or listings",
}, PROFILE);

const plan = wholeOf(built);

// ── 1. The prompt names every composer field ──────────────────────────────
//
// This list is the contract. It is duplicated in index.html as
// PLATFORM_COMPOSER_FIELDS, and assertion 2 below proves the two agree — so
// the duplication is checked rather than trusted.
const PINTEREST_FIELDS = [
  "pinTitle", "pinDescription", "altText", "pinBoard", "pinTopics", "destinationLink",
];
const YOUTUBE_FIELDS = [
  "youtubeFormat", "videoTitle", "videoDescription", "videoTags",
  "thumbnailText", "thumbnailDirection", "chapters", "endScreenCta",
];

for (const f of PINTEREST_FIELDS.concat(YOUTUBE_FIELDS)) {
  assert(plan.includes("`" + f + "`"),
    `the plan prompt never asks for \`${f}\` — a card cannot fill a composer box nobody told it about`);
}

// The whole point is that these REPLACE the caption on those two platforms.
// A card that emits both leaves the creator guessing which one to paste.
assert(/do NOT emit a `caption` field on a Pinterest card/.test(plan),
  "the prompt does not tell the model to drop `caption` on Pinterest — the pin has no caption box, so a caption there is copy with nowhere to go");
assert(/do NOT emit a `caption` field on a YouTube card/.test(plan),
  "the prompt does not tell the model to drop `caption` on YouTube — `videoDescription` is the box, and two fields for one box is a coin flip");

// ── 2. The renderer and the prompt agree on the field names ───────────────
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const tableMatch = indexHtml.match(/var PLATFORM_COMPOSER_FIELDS = \{[\s\S]*?\n\};/);
assert(!!tableMatch, "PLATFORM_COMPOSER_FIELDS is gone from index.html — nothing renders the composer fields any more");

if (tableMatch) {
  const table = tableMatch[0];
  const rendered = new Set(Array.from(table.matchAll(/key:"([A-Za-z]+)"/g), m => m[1]));
  // youtubeFormat is prompt-only on purpose: it selects which fields apply
  // (chapters and end screens are long-form only), it is not itself a box the
  // creator pastes into, so it has no row.
  const expectRendered = PINTEREST_FIELDS
    .concat(YOUTUBE_FIELDS.filter(f => f !== "youtubeFormat"));
  for (const f of expectRendered) {
    assert(rendered.has(f),
      `the prompt asks for \`${f}\` but the card has no row for it — the model would write it and the creator would never see it`);
  }
  for (const f of rendered) {
    assert(expectRendered.includes(f),
      `the card renders a \`${f}\` row the plan prompt never asks for — it will be blank on every card`);
  }
}

// The copy path has to hand these over labelled. An unlabelled blob is how a
// pin title ended up in a description box in the first place.
assert(/f\.label\.toUpperCase\(\)/.test(indexHtml),
  "buildCardCopyText no longer labels the composer fields — copying them as one blob is the bug this work fixed");

// ── 3. Every new field is assigned a register ─────────────────────────────
//
// A field in neither set is a field the bleed detector and the drift corpus
// both skip: VIRL's voice could leak into a pin description and nothing would
// catch it.
const PUBLISHED = ["pinTitle", "pinDescription", "altText", "videoTitle", "videoDescription", "thumbnailText"];
const DIRECTION = ["pinBoard", "pinTopics", "destinationLink", "videoTags", "thumbnailDirection", "endScreenCta"];

for (const f of PUBLISHED) {
  assert(CREATOR_VOICE_FIELDS.has(f),
    `\`${f}\` publishes under the creator's name but is not in CREATOR_VOICE_FIELDS — the drift scorer and the bleed detector will both skip it`);
  assert(plan.includes(f), `\`${f}\` is missing from the plan prompt's register split`);
}
for (const f of DIRECTION) {
  assert(VIRL_VOICE_FIELDS.has(f),
    `\`${f}\` is direction or plumbing, not published copy, but is not in VIRL_VOICE_FIELDS`);
}
for (const f of PUBLISHED) {
  assert(!VIRL_VOICE_FIELDS.has(f), `\`${f}\` is in both register sets — it can only be one`);
}

// ── 4. The platform rules that decide whether a post is findable ──────────
//
// Each of these is a real platform constraint a creator cannot see from the
// composer, and each was absent before this pass. They are asserted
// individually because losing any one of them costs the creator reach without
// ever showing an error.
assert(/first 40 characters/.test(plan),
  "the prompt does not say only ~40 characters of a pin title show in feed and search — the reason to front-load the keyword");
assert(/500 characters/.test(plan),
  "the prompt states no length target for the pin description — Pinterest ranks it as text and the field caps at 500");
assert(/screen readers/.test(plan) && /image recognition/.test(plan),
  "alt text is asked for without saying what it is for — that is how it becomes a second copy of the description");
// Pinterest ranking is keyword ranking. Naming the field is not the same as
// saying what goes in it — the first pass asked for a description that carried
// "the search terms" and left how many, where, and from what entirely open.
assert(/2-3 DISTINCT keyword phrases/.test(plan),
  "the pin description rule states no keyword count — Pinterest ranks the description text, and 'include keywords' is not a recommendation");
assert(/INSIDE THE FIRST SENTENCE/.test(plan),
  "nothing says the primary phrase goes in the first sentence — the description truncates, so a phrase further down does not work");
assert(/long-tail, high-intent phrasing/.test(plan),
  "no guidance on long-tail vs broad keywords — a broad head term is where a small account never surfaces");
assert(/PINTEREST KEYWORD CLUSTER/.test(plan),
  "the title, description, board and topics are matched together, and nothing tells the model to keep them on one phrase");
assert(/NO search-volume or keyword-difficulty data/.test(plan),
  "nothing stops the model presenting an invented keyword as researched — same defect class as the fabricated stats and invented trends this file already guards");
assert(/does not label which platform each item came from/.test(plan),
  "the prompt does not rule the trends block out as a keyword source — its items are not reliably platform-labelled, so treating one as a Pinterest search term invents provenance");

assert(/never invent a deeper path/i.test(plan),
  "nothing stops the model inventing a destination URL — a pin pointing at a 404 is worse than a pin with no link");
assert(/first 60/.test(plan),
  "the prompt does not say a YouTube title is truncated past ~60 characters in search and on mobile");
assert(/is NOT publishable as a video title/.test(plan),
  "nothing tells the model the card's own `title` is a VIRL headline, not a YouTube title — that conflation is what left the field unwritten");
assert(/above the '\.\.\.more' fold/.test(plan),
  "the prompt does not name the YouTube description fold — the first two lines are the only ones most viewers read");
assert(/first timestamp is exactly 0:00/.test(plan) && /at least 3 chapters/.test(plan) && /at least 10 seconds/.test(plan),
  "the chapter rules are incomplete — YouTube drops the ENTIRE chapter list, silently, if any one of the three is broken");
assert(/past 15 hashtags YouTube ignores every hashtag/.test(plan),
  "the prompt does not state YouTube's hashtag ceiling — past 15 the platform ignores all of them, not just the extras");
assert(/at most 3 minutes/.test(plan),
  "the prompt does not say where Shorts ends and long-form begins, so `youtubeFormat` has nothing to key off");

// ── 5. The final check enforces the fields it asks for ────────────────────
assert(/every platform=Pinterest card includes/.test(plan) && /every platform=YouTube card includes/.test(plan),
  "the plan prompt's FINAL CHECK does not cover the composer fields — the format fields are checked there because listing a field is not the same as getting one");

// ── 6. A regenerated card keeps its composer fields ───────────────────────
//
// Partial regeneration is a 1-credit action creators use constantly. It
// inherits the system prompt, so the field definitions come along — but its
// user prompt restates the per-card rules, and it used to name only the
// format-specific ones.
const regen = dispatch("plan_partial", {
  platforms: ["Pinterest", "YouTube"],
  formats:   ["single_image", "video"],
  niche:     "Small Business",
  cards:     [{ day: "Day 1 - Mon", platform: "Pinterest", format: "single_image", title: "A pin" }],
  replaceSlots: [{ day: "Day 1 - Mon", platform: "Pinterest", format: "single_image" }],
  strategy:  { thesis: "Search-led traffic" },
}, PROFILE);
const regenPrompt = wholeOf(regen);
assert(/platform-specific composer fields/.test(regenPrompt),
  "a regenerated card is not told to carry its composer fields — swapping a Pinterest card would strip its title, description and alt text");
assert(regenPrompt.includes("`pinDescription`"),
  "the partial-regen prompt does not inherit the composer field definitions");

if (failures > 0) {
  console.error(`\nComposer-field check FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log("OK: Pinterest + YouTube composer fields are asked for, rendered, registered, and survive regeneration.");
