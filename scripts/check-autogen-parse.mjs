// scripts/check-autogen-parse.mjs
//
// [A1] Guards the parse step of the proactive Monday plan. From launch until
// this check existed, every autogen run failed with
//   Unexpected token '`', "```json ..." is not valid JSON
// because the cron fed the streamed plan text straight to JSON.parse and the
// model sometimes wraps its JSON in a fence. The browser tolerated it; the
// cron did not, and nothing noticed for five weeks.
//
// Feeds parsePlanText (api/cron/strategist-touches.js) the three shapes the
// model actually produces, plus the two failures it must report clearly.

import { parsePlanText, planExpiryISO } from "../api/cron/strategist-touches.js";

let failures = 0;
function check(label, fn) {
  try { fn(); console.log("ok   " + label); }
  catch (e) { failures++; console.error("FAIL " + label + ": " + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const plan = {
  week_note: "A steady week. Two reach posts up front, then trust.",
  cards: [
    { day: "Monday", title: "The kitchen nobody expected", platform: "Instagram", caption: "This one has a fence inside a caption: ```not json```" },
    { day: "Wednesday", title: "Three questions to ask before you list", platform: "TikTok" },
  ],
  stats: { posts: 2 },
};
const json = JSON.stringify(plan, null, 2);

function sameCards(parsed) {
  assert(parsed && Array.isArray(parsed.cards), "no cards array");
  assert(parsed.cards.length === 2, "expected 2 cards, got " + parsed.cards.length);
  assert(parsed.cards[0].title === plan.cards[0].title, "first card title changed");
  assert(parsed.week_note === plan.week_note, "week_note changed");
}

check("unfenced JSON parses", () => sameCards(parsePlanText(json)));
check("```json fenced JSON parses", () => sameCards(parsePlanText("```json\n" + json + "\n```")));
check("bare ``` fence parses", () => sameCards(parsePlanText("```\n" + json + "\n```\n")));
check("text before the JSON parses", () => sameCards(parsePlanText("Here's your week, built from the strategy.\n\n" + json)));
check("text before a fenced block parses", () => sameCards(parsePlanText("Here's your week:\n```json\n" + json + "\n```\nLet me know.")));

check("garbage throws with the first 200 chars in the message", () => {
  const junk = "I couldn't build this week because " + "x".repeat(400);
  let msg = "";
  try { parsePlanText(junk); } catch (e) { msg = e.message; }
  assert(msg.includes("did not parse"), "error should say it did not parse, got: " + msg);
  assert(msg.includes("I couldn't build this week"), "error should quote the start of the text");
  assert(!msg.includes("x".repeat(250)), "error should quote at most ~200 chars");
});
check("a plan with no cards throws 'empty plan'", () => {
  let msg = "";
  try { parsePlanText("```json\n{\"cards\": []}\n```"); } catch (e) { msg = e.message; }
  assert(msg === "empty plan", "got: " + msg);
});

// [A1b] Expiry mirrors computePlanExpiry in index.html. The autogen runs the
// evening before the slot; with a Sunday slot and Sunday weeks that is
// Saturday, one day left, so the plan must live through the FOLLOWING week.
// The old weekStart + 7 days at 00:00 UTC expired it at 6pm Chicago that
// same evening.
const expiryCases = [
  ["Saturday 6pm Chicago, Sunday weeks: through next week", "2026-11-22T00:00:00Z", "2026-11-15", "America/Chicago", 0, "2026-11-29T06:00:00.000Z"],
  ["Wednesday Chicago: end of this week, local midnight", "2026-11-18T15:00:00Z", "2026-11-15", "America/Chicago", 0, "2026-11-22T06:00:00.000Z"],
  ["Saturday New York across the DST change", "2026-03-07T23:00:00Z", "2026-03-01", "America/New_York", 0, "2026-03-15T04:00:00.000Z"],
  ["Saturday London, Monday weeks: through next week", "2026-11-21T20:00:00Z", "2026-11-16", "Europe/London", 1, "2026-11-30T00:00:00.000Z"],
];
for (const [label, now, ws, tz, wsd, want] of expiryCases) {
  check("expiry: " + label, () => {
    const got = planExpiryISO(ws, new Date(now), tz, wsd);
    assert(got === want, `expected ${want}, got ${got}`);
    assert(Date.parse(got) > Date.parse(now), "plan expires before it is generated");
  });
}

if (failures) { console.error(`\n${failures} autogen parse check(s) failed.`); process.exit(1); }
console.log("OK: autogen plan parsing tolerates fences and leading text, fails loudly otherwise, and stores a plan that outlives its email.");
