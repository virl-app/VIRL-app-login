// scripts/check-strategy-build.mjs
//
// [PR1] Deterministic, no-network checks on the strategist's plumbing:
//   A. the brief's example strategy validates, and common defects don't;
//   B. the JSON-patch applier does what the interpreter relies on;
//   C. the three prompts assemble with the persona and the text-first
//      rules, and the rubric wording they embed is the shared one;
//   D. a profile that carries a strategy reaches every prose surface, and
//      the plan prompt names the pillar contract.
// Prints OK / FAIL, exits 1 on any failure.

import { dispatch } from "../api/_lib/prompts.js";
import { validateStrategy, normalisePillarShares, STRATEGY_JSON_SCHEMA } from "../api/_lib/strategy-schema.js";
import { applyPatch, diffStrategies } from "../api/_lib/json-patch.js";
import { heardPrompt, buildPrompt, interpretPrompt, formatStrategyForPrompt, TEXT_FIRST_RULES } from "../api/_lib/strategist-prompts.js";
import { migrateProfile } from "../api/strategy.js";
import fs from "node:fs";
const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

let failures = 0;
function assert(cond, msg) { if (cond) return; failures += 1; console.error("FAIL:", msg); }

const STRATEGY = {
  goal: { primary: "clients", secondary: ["authority"] },
  identity: "med spa owner in Franklin, TN",
  edge: "straight-talking, shows exactly what happens",
  audience: ["women 30 to 55 nearby", "first-time injectable clients"],
  struggle: "nervous about their first treatment",
  market: { type: "local", city: "Franklin, TN" },
  price_band: "$50 to $500",
  positioning: "For Franklin women nervous about their first treatment, you're the one who shows exactly what happens.",
  platform: { primary: "Instagram", rework: ["Facebook", "Threads"] },
  stage: "grow",
  pillars: [
    { name: "Behind the results", role: "trust", share: 40, job: "Teach what a treatment actually looks like." },
    { name: "Franklin faces", role: "connection", share: 30, job: "Make the practice feel like neighbours." },
    { name: "Book it", role: "convert", share: 30, job: "Turn a question into a consult." },
  ],
  formats: ["talking to camera", "clips with voiceover", "one rendered static post a week"],
  cadence: { posts_per_week: 3, batch: "one 45-minute session", slot: { weekday: "Sunday", time: "7pm", place: "kitchen table" } },
  path_to_results: "Post, then profile, then DM or booking link.",
  metrics: ["DMs started", "Bookings mentioned in DMs", "Profile link clicks"],
  guardrails: { off_limits: [], rules: "No guaranteed results (medical aesthetics)." },
  opening_note: "Here's my read. You don't need more reach, you need the nervous first-timer to trust you before she walks in.",
  still_learning: ["whether evening or lunchtime posts land"],
  first_post: { hook: "What a first Botox appointment actually looks like.", outline: "Walk in\nConsult\nThe part people fear\nAfter", caption: "if you've been thinking about it and scared to ask, this is the whole thing. no filter.", why: "Trust post. Your audience's stated struggle is fear of the first visit." },
};

// ── A. schema + validator ─────────────────────────────────────────────────
assert(validateStrategy(STRATEGY).length === 0, "the brief's example strategy should validate: " + validateStrategy(STRATEGY).join(", "));
assert(STRATEGY_JSON_SCHEMA.properties.platform.properties.primary.enum.indexOf("Pinterest") < 0, "Pinterest must never be a primary platform");
assert(STRATEGY_JSON_SCHEMA.properties.platform.properties.primary.enum.indexOf("Other") < 0, "Other must never be a primary platform");
{
  const bad = JSON.parse(JSON.stringify(STRATEGY)); bad.platform.rework.push("Instagram");
  assert(validateStrategy(bad).some(p => /rework contains primary/.test(p)), "a rework list containing the primary must be rejected");
  const off = JSON.parse(JSON.stringify(STRATEGY)); off.pillars[0].share = 70;
  assert(validateStrategy(off).some(p => /share total/.test(p)), "pillar shares off 100 must be rejected");
  normalisePillarShares(off);
  assert(off.pillars.reduce((n, p) => n + p.share, 0) === 100, "normalisePillarShares must bring shares back to 100");
  const empty = JSON.parse(JSON.stringify(STRATEGY)); empty.first_post.caption = "  ";
  assert(validateStrategy(empty).includes("first_post"), "an empty first_post caption must be rejected");
}
// Structured-output limits: every object closed, no numeric/string constraints.
{
  const offenders = [];
  (function walk(node, path) {
    if (!node || typeof node !== "object") return;
    if (node.type === "object" && node.additionalProperties !== false) offenders.push(path + " (open object)");
    for (const k of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) if (k in node) offenders.push(path + " (" + k + ")");
    if (node.properties) for (const [k, v] of Object.entries(node.properties)) walk(v, path + "." + k);
    if (node.items) walk(node.items, path + "[]");
  })(STRATEGY_JSON_SCHEMA, "schema");
  assert(offenders.length === 0, "STRATEGY_JSON_SCHEMA uses constraints structured outputs reject: " + offenders.join(", "));
}

// ── B. json-patch ─────────────────────────────────────────────────────────
{
  const next = applyPatch(STRATEGY, [
    { op: "replace", path: "/pillars/2/share", value: 20 },
    { op: "replace", path: "/pillars/0/share", value: 50 },
    { op: "add", path: "/formats/-", value: "quote card" },
    { op: "remove", path: "/platform/rework/1" },
  ]);
  assert(STRATEGY.pillars[2].share === 30, "applyPatch must not mutate the input");
  assert(next.pillars[2].share === 20 && next.pillars[0].share === 50, "replace on a nested array item");
  assert(next.formats[next.formats.length - 1] === "quote card", "add with '-' appends");
  assert(next.platform.rework.length === 1 && next.platform.rework[0] === "Facebook", "remove on an array index");
  const d = diffStrategies(STRATEGY, next);
  assert(d.some(x => x.path === "/pillars/2/share" && x.before === 30 && x.after === 20), "diffStrategies reports the changed leaf with before/after");
  let threw = false;
  try { applyPatch(STRATEGY, [{ op: "replace", path: "/nope/0", value: 1 }]); } catch (e) { threw = true; }
  assert(threw, "a patch against a missing path must throw, not half-apply");
}

// ── C. prompts ────────────────────────────────────────────────────────────
{
  const h = heardPrompt({ goal: "clients", about: "I run a med spa in Franklin." });
  assert(/YOU ARE VIRL/.test(h.system) && /GOAL they picked: Bring me clients/.test(h.prompt), "heard prompt carries the persona and the goal label");
  const b = buildPrompt({ goal: { primary: "clients", secondary: [] }, about: "x", heard: {}, reality: { platforms: ["LinkedIn"] }, voice: { sample: "hey y'all, don't skip this one" } }, [{ finding: "People ask about pricing first", source_url: "https://example.com" }], { playbookLines: "LinkedIn: cadence 2-3/wk" });
  assert(/YOU ARE VIRL/.test(b.system) && /TEXT-FIRST PLATFORMS/.test(b.system) && /ONE PRIMARY PLATFORM/.test(b.system), "build prompt carries persona + text-first + one-primary rules");
  assert(/Before finalizing, silently review your draft/.test(b.system), "build prompt embeds the shared self-check rubric");
  assert(/USE CONTRACTIONS BY DEFAULT/.test(b.system), "build prompt embeds STYLE_GUARD");
  assert(/People ask about pricing first/.test(b.prompt) && /VOICE SAMPLE/.test(b.prompt), "build prompt carries research and the voice sample");
  assert(/Pinterest is never primary/.test(TEXT_FIRST_RULES) && /at most 3, never in the first line/.test(TEXT_FIRST_RULES), "text-first rules match the brief");
  const i = interpretPrompt({ strategy: STRATEGY, section: "pillars", text: "too salesy", notes: ["keep it warm"] });
  assert(/JSON Patch/.test(i.system) && /SECTION they were looking at: pillars/.test(i.prompt) && /keep it warm/.test(i.prompt), "interpret prompt names the section, prior notes, and JSON Patch");
  const f = formatStrategyForPrompt(STRATEGY, ["less selling please"]);
  assert(/THE CREATOR'S STRATEGY/.test(f) && /Behind the results \[trust, 40%\]/.test(f) && /less selling please/.test(f), "formatStrategyForPrompt renders pillars with roles and the notes");
}

// ── D. the strategy reaches generation ───────────────────────────────────
{
  const profile = { name: "Lauren", voice: "warm", audience: "x", sampleCaption: "ok so here's the thing, mornings are hard and i'm not gonna pretend they're not", strategy: STRATEGY, strategistNotes: ["less selling"], emojiPref: "Sometimes", emojiWhere: "end" };
  const flat = sp => typeof sp === "string" ? sp : (sp.shared || "") + "\n" + (sp.perUser || "");
  const surfaces = [
    ["plan", { platforms: ["Instagram"], formats: ["video"], niche: "Small Business", goal: "Sell my services", followers: "1K-5K" }],
    ["caption", { platform: "Instagram", topic: "first visit" }],
    ["script", { card: { title: "First visit", description: "walkthrough", platform: "Instagram", format: "video" } }],
    ["scan_image", {}],
  ];
  for (const [gt, params] of surfaces) {
    const built = dispatch(gt, params, profile, null, {}, {}, [], [], null, null);
    const text = flat(built.systemPrompt) + "\n" + (built.userPrompt || "");
    assert(/THE CREATOR'S STRATEGY/.test(text), gt + ": a stored strategy never reached the prompt");
    assert(/less selling/.test(text), gt + ": strategist notes never reached the prompt");
    assert(/EMOJI PLACEMENT: only at the end/.test(text), gt + ": emoji placement toggle never reached the prompt");
  }
  const plan = dispatch("plan", surfaces[0][1], profile, null, {}, {}, [], [], null, null);
  assert(/pillar_role/.test(plan.userPrompt || ""), "plan: with a strategy, cards must be asked to carry pillar_role");
  const none = dispatch("plan", surfaces[0][1], Object.assign({}, profile, { strategy: null }), null, {}, {}, [], [], null, null);
  assert(!/THE CREATOR'S STRATEGY/.test(flat(none.systemPrompt)), "plan: without a strategy the old path must run unchanged");
}

// ── E. the old profile maps onto the interview ───────────────────────────
{
  const m = migrateProfile({ voice: "warm, witty", offerings: "balayage", my_platforms: ["Instagram", "YouTube"], vibes: ["Warm & nurturing", "Witty & dry", "Hype & energetic", "Soft & aesthetic"], sample_caption: "my guys.", voice_samples: ["if they don't remember"], emoji_pref: "Never" });
  assert(m.platforms.value.includes("YouTube Shorts") && !m.platforms.value.includes("YouTube"), "YouTube maps to YouTube Shorts");
  assert(m.tone.value.length === 3, "tone keeps at most 3 chips");
  assert(m.sample.value.includes("my guys.") && m.sample.value.includes("if they don't remember"), "voice sample joins caption and samples");
  assert(m.emoji_use.value === "none", "Never maps to no emojis");
  assert(Object.values(m).every(v => v.source === "migrated"), "every migrated field says so");
}

// ── F. [PR2] the plan a strategy account gets ─────────────────────────────
{
  const profile = { name: "Lauren", voice: "warm", audience: "x", sampleCaption: "ok so here's the thing, mornings are hard and i'm not gonna pretend they're not", strategy: STRATEGY, strategistNotes: [], emojiPref: "Sometimes",
    postsSummary: { posted: 1, skipped: 3, byReason: { no_time: 2, not_me: 1 }, weeksSilent: 0 } };
  const params = { platforms: ["Instagram", "LinkedIn", "Threads"], formats: ["Carousel", "Text post"], niche: "Small Business", goal: "Generate leads", followers: "1K-5K" };
  const built = dispatch("plan", params, profile, null, {}, {}, [], [], null, null);
  const user = built.userPrompt || "";
  for (const needle of ["`week_note`", "`drift`", "`daily_comments`", "`pillar_role`", "`is_rework`", "`rework_note`", "`sounds_like_you`", "`rendered`: true", "TEXT-FIRST PLATFORMS", "ONE PRIMARY PLATFORM", "LinkedIn 150 to 300 words", "no time (2 times)"]) {
    assert(user.includes(needle), "plan with strategy: user prompt lacks " + needle);
  }
  assert(!/daily_comments/.test(dispatch("plan", Object.assign({}, params, { platforms: ["Instagram"] }), Object.assign({}, profile, { strategy: Object.assign({}, STRATEGY, { platform: { primary: "Instagram", rework: [] } }) }), null, {}, {}, [], [], null, null).userPrompt || ""),
    "plan without LinkedIn must not ask for daily_comments");
  const silent = dispatch("plan", params, Object.assign({}, profile, { postsSummary: { posted: 0, skipped: 0, byReason: {}, weeksSilent: 2 } }), null, {}, {}, [], [], null, null);
  assert(/dropping the cadence by one/.test(silent.userPrompt || ""), "two silent weeks must propose dropping cadence by one");
  const plain = dispatch("plan", params, Object.assign({}, profile, { strategy: null, postsSummary: null }), null, {}, {}, [], [], null, null);
  assert(!/week_note/.test(plain.userPrompt || ""), "a non-strategy plan must not carry the strategist additions");
}

// ── G. [PR2] slot timing helpers and the renderer ─────────────────────────
{
  const { slotHour, weekdayIndex, localParts } = await import("../api/cron/strategist-touches.js");
  const cases = { "9p": 21, "9pm": 21, "7:30 PM": 19, "19:00": 19, "evening": 19, "7": 19, "noon": 12, "12am": 0, "": 19, "6am": 6 };
  for (const [k, v] of Object.entries(cases)) assert(slotHour(k) === v, `slotHour("${k}") should be ${v}, got ${slotHour(k)}`);
  assert(weekdayIndex("Sunday") === 0 && weekdayIndex("wed") === 3, "weekdayIndex");
  const lp = localParts(new Date("2026-10-12T01:30:00Z"), "America/Chicago");
  assert(lp.weekday === 0 && lp.hour === 20 && lp.dateISO === "2026-10-11", "localParts must convert to the creator's zone: " + JSON.stringify(lp));
  assert(localParts(new Date(), "Not/AZone").tz === "America/Chicago", "an unknown zone falls back to the default");
  const { renderSlides, renderPdf, slidesFromCard, resolveBrand } = await import("../api/_lib/render-post.js");
  assert(resolveBrand({ bg: "red" }).bg === "#1F3A8A" && resolveBrand({ bg: "#000000" }).bg === "#000000", "resolveBrand validates hex");
  const slides = slidesFromCard({ title: "t", slides: [{ headline: "One", body: "a" }, { headline: "Two", body: "b" }, { headline: "Three", body: "c" }] });
  const pngs = await renderSlides(slides, { kicker: "k", footer: "@x" });
  assert(pngs.length === 3 && pngs[0].length > 5000 && pngs[0][0] === 0x89, "renderSlides must return PNG buffers");
  const pdf = await renderPdf(pngs);
  assert(pdf.length > 5000 && pdf.slice(0, 4).toString() === "%PDF", "renderPdf must return a PDF");
  assert(slidesFromCard({ quote: "q", attribution: "a" })[0].quote === "q", "a quote card renders as a quote slide");

  // [PROFILE PR] Headline font choice: curated ids validate, uploads are
  // path-checked, unknown input means Italiana, and the client list in
  // index.html names the same ids as the server.
  const { FONT_CHOICES, resolveFontChoice, fontKind, fontsForBrand } = await import("../api/_lib/render-post.js");
  assert(resolveFontChoice({ kind: "google", id: "playfair" }).family === "Playfair Display", "a curated font resolves to its family");
  assert(resolveFontChoice({ kind: "google", id: "italiana" }) === null && resolveFontChoice({ kind: "google", id: "comic" }) === null, "Italiana and unknown ids mean the default");
  assert(resolveFontChoice({ kind: "upload", path: "../etc/passwd" }) === null, "an upload path must be <uuid>/<file>");
  assert(resolveFontChoice({ kind: "upload", path: "123e4567-e89b-12d3-a456-426614174000/brand-font.otf", name: "x" }).kind === "upload", "a well-formed upload path is accepted");
  assert(fontKind(Buffer.from("wOF2xxxx")) === null && fontKind(Buffer.from("OTTOxxxx")) === "otf" && fontKind(Buffer.from([0, 1, 0, 0, 9])) === "ttf", "fontKind reads magic bytes and rejects WOFF2");
  const broken = await fontsForBrand({ font: { kind: "upload", path: "123e4567-e89b-12d3-a456-426614174000/x.ttf" } }, { SUPABASE_URL: "https://127.0.0.1:9", SUPABASE_SERVICE_KEY: "k" });
  assert(broken.headlineFamily === "Italiana" && broken.fallback === true, "an unreachable upload falls back to Italiana instead of failing the render");
  const clientIds = [...indexHtml.matchAll(/\{ id: "([a-z]+)", family: "/g)].map(m => m[1]);
  assert(clientIds.length === FONT_CHOICES.length && clientIds.every(id => FONT_CHOICES.some(c => c.id === id)), "SG_FONTS in index.html must list the same ids as FONT_CHOICES: " + clientIds.join(","));
  assert(fs.readFileSync("migrations/031-brand-fonts-bucket.sql", "utf8").includes("'brand-fonts'"), "migration 031 creates the brand-fonts bucket");
}

if (failures > 0) { console.error(`\nStrategy check FAILED with ${failures} failure(s).`); process.exit(1); }
console.log("OK: strategy schema, patcher, prompts and plan hand-off hold together.");
