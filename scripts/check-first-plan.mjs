// scripts/check-first-plan.mjs
//
// [B] Guards PR B: a brand-new signup leaves the first session with a week
// of posts, not just a strategy.
//
//   B1  sgPlanSetupFromStrategy (index.html) builds the same plan setup the
//       Monday autogen cron does from the same strategy, so the first plan
//       and every autogen plan target the same platforms and formats. Before
//       B1 the first plan used the form's defaults (TikTok + Instagram).
//       Also asserts the wiring: only a FIRST strategy auto-generates, it
//       goes through generate() (the Generate button's own call), and a
//       failure lands on a one-tap card rather than an error alone.
//   B2  sgReadDraft restores a matching draft and refuses the wrong mode,
//       a stale one, or junk.
//   B3  voice notes run to 90 seconds, warn at 75, send the real duration,
//       and the server rejects oversize audio instead of truncating it.

import { readFileSync } from "node:fs";
import { formatsFor, followersFor, OLD_GOAL } from "../api/cron/strategist-touches.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const strategySrc = readFileSync(new URL("../api/strategy.js", import.meta.url), "utf8");

let failures = 0;
function assert(cond, msg) { if (!cond) { failures++; console.error("FAIL " + msg); } }

// Pull a top-level function / var out of index.html by name.
function grab(name) {
  const start = html.search(new RegExp("^(function " + name + "\\(|var " + name + " = )", "m"));
  if (start < 0) throw new Error("index.html has no " + name);
  if (html.startsWith("var ", start)) return html.slice(start, html.indexOf(";\n", start) + 2);
  let depth = 0, i = html.indexOf("{", start);
  for (; i < html.length; i++) { if (html[i] === "{") depth++; else if (html[i] === "}" && --depth === 0) break; }
  return html.slice(start, i + 1);
}
const PLATFORMS = JSON.parse(html.match(/^const PLATFORMS = (\[[^\]]*\]);/m)[1]);
const FORMATS = JSON.parse(html.match(/^const FORMATS = (\[[^\]]*\]);/m)[1]);
const GOALS = JSON.parse(html.match(/^const GOALS = (\[[^\]]*\]);/m)[1]);
const FOLLOWERS = JSON.parse(html.match(/^const FOLLOWERS = (\[[^\]]*\]);/m)[1]);

// ── B1: the mapping agrees with the cron ───────────────────────────────────
const sgPlanSetupFromStrategy = new Function("PLATFORMS",
  grab("SG_PLAN_GOAL") + "\n" + grab("sgPlanSetupFromStrategy") + "\nreturn sgPlanSetupFromStrategy;")(PLATFORMS);

const fixtures = [
  { name: "Instagram + TikTok, reels and carousels", strategy: { platform: { primary: "Instagram", rework: ["TikTok"] }, formats: ["On-camera reels", "Carousels"], goal: { primary: "clients" } }, sizes: { Instagram: "1k_10k" } },
  { name: "YouTube Shorts maps to YouTube", strategy: { platform: { primary: "YouTube Shorts", rework: [] }, formats: ["Voiceover over b-roll", "How-to tutorial"], goal: { primary: "authority" } }, sizes: { "YouTube Shorts": "10k+" } },
  { name: "LinkedIn text-first", strategy: { platform: { primary: "LinkedIn" }, formats: ["Text-first LinkedIn posts"], goal: { primary: "income" } }, sizes: {} },
  { name: "no formats falls back", strategy: { platform: { primary: "Facebook", rework: ["Pinterest"] }, formats: [], goal: { primary: "unsure" } }, sizes: { Facebook: "under_1k" } },
  { name: "unknown goal", strategy: { platform: { primary: "X" }, formats: ["Day in the life"], goal: { primary: "something-new" } }, sizes: {} },
];
for (const f of fixtures) {
  const answers = { reality: { sizes: f.sizes } };
  const got = sgPlanSetupFromStrategy(f.strategy, answers);
  const want = {
    formats: formatsFor(f.strategy),
    goal: OLD_GOAL[f.strategy.goal.primary] || "Grow my following",
    followers: followersFor({ onboarding_answers: answers }, f.strategy.platform.primary),
  };
  for (const k of Object.keys(want)) assert(JSON.stringify(got[k]) === JSON.stringify(want[k]), `${f.name}: ${k} differs from the cron (${JSON.stringify(got[k])} vs ${JSON.stringify(want[k])})`);
  assert(got.platforms.length > 0 && got.platforms.every(p => PLATFORMS.includes(p)), `${f.name}: platforms must be from PLATFORMS: ${got.platforms}`);
  assert(got.formats.every(x => FORMATS.includes(x)), `${f.name}: formats must be from FORMATS: ${got.formats}`);
  assert(GOALS.includes(got.goal), `${f.name}: goal must be from GOALS: ${got.goal}`);
  assert(FOLLOWERS.includes(got.followers), `${f.name}: followers must be from FOLLOWERS: ${got.followers}`);
}
assert(JSON.stringify(sgPlanSetupFromStrategy(fixtures[1].strategy, {}).platforms) === '["YouTube"]', "YouTube Shorts must become YouTube");
assert(sgPlanSetupFromStrategy({ platform: { primary: "Threads", rework: ["Other"] } }, {}).platforms.length === 0, "Threads/Other alone yields no platforms (the wizard asks instead)");
assert(JSON.stringify(sgPlanSetupFromStrategy(fixtures[0].strategy, {}).platforms) === '["Instagram","TikTok"]', "primary first, then rework");

// Wiring
const onBuilt = html.slice(html.indexOf("var sgOnBuilt = function"), html.indexOf("if (sgEdit) return ("));
assert(/var firstStrategy = !sgHasStrategy && !sgEdit && !sgRestart;/.test(onBuilt), "only a first strategy (not edit, not start-over) may auto-generate");
assert(/sgPlanSetupFromStrategy\(strategy, answers\)/.test(onBuilt) && /setFirstPlan\("auto"\)/.test(onBuilt), "a first strategy seeds the plan form and asks for the first plan");
assert(/else \{\s*setTab\("strategy"\);/.test(onBuilt), "rebuilds still land on the Strategy tab");
assert(/if \(firstPlan !== "auto" \|\| tab !== "plan" \|\| loading\) return;[\s\S]{0,120}generate\(\);/.test(html), "the first plan runs through generate(), the Generate button's own call");
assert(/setFirstPlan\(cards && cards.length \? null : "card"\)/.test(html), "a first plan that doesn't land shows the card");
assert(html.includes('firstPlan === "card" && !loading && !cards') && html.includes(">Plan this week</GenBtn>"), "the one-tap card renders");
assert(html.includes("Writing your first week from the strategy we just built."), "the first-plan loading line renders");
assert(/"first_plan_generated", \{\s*ms_since_signup:[\s\S]{0,140}auto: !!firstPlanAutoRef.current/.test(html), "first_plan_generated logs ms_since_signup and auto");
assert(/planNeeded=\{!\(cards && cards.length\) \|\| planExpired\}/.test(html) && /\{planNeeded && \(/.test(html) && /\{!planNeeded && \(/.test(html), "the Strategy page puts 'Plan this week from it' on top when there's no current plan");
assert(/<GenBtn onClick=\{function\(\)\{ setShowSetup\(false\); generate\(\); \}\}/.test(html), "the manual Generate button is unchanged");

// ── B2: drafts ─────────────────────────────────────────────────────────────
const store = new Map();
const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const sgReadDraft = new Function("localStorage", grab("sgReadDraft") + "\nreturn sgReadDraft;")(localStorage);
const good = { v: 1, mode: "new", idx: 2, answers: { about: "I run a med spa" }, savedAt: Date.now() };
store.set("k", JSON.stringify(good));
assert(sgReadDraft("k", "new") && sgReadDraft("k", "new").idx === 2, "a fresh draft in the same mode restores");
assert(sgReadDraft("k", "meet") === null, "a draft from the other mode is ignored");
store.set("k", JSON.stringify(Object.assign({}, good, { savedAt: Date.now() - 31 * 86400000 })));
assert(sgReadDraft("k", "new") === null, "a draft older than 30 days is ignored");
store.set("k", "{not json");
assert(sgReadDraft("k", "new") === null, "junk is ignored, not thrown");
assert(sgReadDraft(null, "new") === null && sgReadDraft("missing", "new") === null, "no key or no draft is null");
const ob = html.slice(html.indexOf("function StrategistOnboarding("), html.indexOf("function StrategistOnboarding(") + 16000);
assert(/"virl_sg_draft_" \+ session\.user\.id/.test(ob), "the draft key is virl_sg_draft_<userId>");
assert(/edit \|\| \(profile && profile\.onboardingAnswers\) \? null : sgReadDraft/.test(ob), "edit mode and start-overs never restore a draft");
assert(/sgLog\("strategist_resumed", \{ screen:/.test(ob), "a restore logs strategist_resumed with the screen");
assert((ob.match(/saveDraft\(Math\.min\(idx \+ 1/g) || []).length === 2, "next() and skip() both save the draft");
assert(/localStorage\.removeItem\(draftKey\)[\s\S]{0,80}onBuilt\(/.test(html), "a successful build clears the draft");
assert(/try \{ localStorage\.setItem\(draftKey/.test(ob), "saving the draft is wrapped in try/catch");

// ── B3: voice notes ────────────────────────────────────────────────────────
assert(/var SG_VOICE_MAX_SECS = 90;/.test(html) && /var SG_VOICE_WARN_SECS = 75;/.test(html), "voice notes cap at 90s and warn at 75s");
assert(!/>= 30\) \{ stop\(\); \}/.test(html), "the old 30-second stop is gone");
assert(/durationSec: durationSec/.test(html), "the client sends the recorded duration");
assert(/seconds: durationSec/.test(strategySrc) && !/bytes\.length \/ 16000/.test(strategySrc), "the server logs the real duration, not bytes/16000");
assert(/raw\.length > MAX_AUDIO_B64/.test(strategySrc) && !/str\(body\.audioBase64/.test(strategySrc), "oversize audio is rejected, not truncated");
// 90s at the 64 kbps the recorder asks for, as base64, must fit Vercel's 4.5 MB body.
const b64Bytes = Math.ceil((90 * 64000 / 8) / 3) * 4;
assert(b64Bytes < 4.5 * 1024 * 1024 * 0.5, `90s at 64 kbps is ${b64Bytes} base64 bytes; keep it well under 4.5 MB`);

if (failures) { console.error(`\n${failures} first-plan check(s) failed.`); process.exit(1); }
console.log("OK: first strategies go straight to a first week, drafts survive a refresh, and voice notes run to 90 seconds.");
