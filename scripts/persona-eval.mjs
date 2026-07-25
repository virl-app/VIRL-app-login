// [PERSONA-EVAL] Golden eval set for the VIRL persona rollout (Task Group E).
//
// Unlike scripts/voice-eval-nightly.mjs (which scores stylometric drift against
// real, gitignored user corpora), this eval runs on COMMITTED synthetic
// profiles — scripts/persona-eval-profiles.json — so anyone can run it and the
// before/after numbers in the rollout PR are reproducible.
//
//   ANTHROPIC_API_KEY=sk-... node scripts/persona-eval.mjs
//
// It checks the three things the persona rollout can regress:
//   E2  RATIONALE SWAP TEST — a plan's "why this works" rationales must be
//       tied to THAT creator. We measure two rates per profile:
//         specificity — fraction of rationales that name at least one anchor
//           token from this profile (niche, name, facts, audience).
//         cross-leak  — fraction that name ANOTHER profile's anchors but none
//           of their own (a rationale that would read as more true of someone
//           else). Both directions matter: generic-but-harmless still fails
//           specificity; on-voice-for-the-wrong-brand fails cross-leak.
//   E3  CROSS-FEATURE VOICE CONSISTENCY — the SAME profile's plan cards,
//       caption text, and long-form post must read as one voice. We score
//       each surface's drift against the profile's own reference corpus and
//       report the spread; a large spread means one surface drifted.
//   E4  BEFORE/AFTER — every run appends to persona-eval-history.jsonl with a
//       label (env PERSONA_EVAL_LABEL, e.g. "before-B" / "after-B") so the PR
//       can quote the delta.
//
// Deterministic where it can be (the swap test is pure string work on the
// generated rationales); LLM-in-the-loop only for the generation itself.

import { readFileSync, appendFileSync } from "node:fs";
import { dispatch } from "../api/_lib/prompts.js";
import { computeVoiceDrift, extractVoiceText } from "../api/_lib/voice-drift.js";

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error("Set ANTHROPIC_API_KEY to run the persona eval."); process.exit(1); }
const LABEL = process.env.PERSONA_EVAL_LABEL || "unlabeled";

const PROFILES = JSON.parse(readFileSync(new URL("./persona-eval-profiles.json", import.meta.url), "utf8"));

function flatten(sp) {
  if (typeof sp === "string") return sp;
  return sp ? (sp.shared || "") + "\n" + (sp.perUser || "") : "";
}

async function generate(built) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: built.model,
      max_tokens: Math.min(built.maxTokens || 4000, 8000),
      system: flatten(built.systemPrompt),
      messages: [{ role: "user", content: built.userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return (body.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

function tryParse(text) { try { return JSON.parse(text); } catch (e) { return null; } }

// Anchor tokens that make a rationale specific to ONE profile. Deliberately
// content words only (>3 chars, deduped, lowercased) drawn from the fields a
// good rationale should cite: niche, the creator's name/known-for, their
// personal facts, and their audience. Stopwords stripped so "the", "and",
// "your" don't count as anchors.
const STOP = new Set(("a an and are as at be by для for from has have how in into is it its of on or that the their them they this to up was what when who will with your you creator content post posts week platform social media niche audience brand more most every each not but so").split(" "));
function anchorsFor(p) {
  const raw = [p.niche, p.name, p.knownFor, p.personalFacts, p.loveToReference, p.audience, p.goal]
    .filter(Boolean).join(" ").toLowerCase();
  const words = raw.replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(w => w.length > 3 && !STOP.has(w));
  return Array.from(new Set(words));
}
function hitCount(text, anchors) {
  const t = (text || "").toLowerCase();
  let n = 0;
  for (const a of anchors) if (t.includes(a)) n++;
  return n;
}

// Pull the rationale strings out of a plan (the "why this works" surfaces).
function planRationales(plan) {
  const out = [];
  if (plan && plan.strategy) {
    if (plan.strategy.thesis)  out.push(plan.strategy.thesis);
    if (plan.strategy.the_bet) out.push(plan.strategy.the_bet);
  }
  if (plan && Array.isArray(plan.cards)) {
    for (const c of plan.cards) if (c && c.insight) out.push(c.insight);
  }
  return out;
}

// Everything the creator would PUBLISH (for the voice-consistency score) —
// excludes VIRL's strategist commentary, which is a different register on
// purpose. extractVoiceText already knows the publishable fields per surface.
function surfaceVoiceText(gt, parsed) {
  try { return extractVoiceText(parsed); } catch (e) { return ""; }
}

const anchorsByName = {};
for (const p of PROFILES) anchorsByName[p.name] = anchorsFor(p);

const perProfile = [];

for (const p of PROFILES) {
  const reference = [p.sampleCaption, ...(p.voiceSamples || []), ...(p.handlePostExcerpts || [])]
    .filter(Boolean).join("\n\n");

  const planParams = {
    platforms: ["Instagram", "TikTok"], formats: ["video", "carousel"],
    niche: p.niche, goal: p.goal, followers: "5k-10k",
    weekContext: p.evalTopic ? ("This week: " + p.evalTopic) : "",
  };
  const capParams = { platform: "Instagram", topic: p.evalTopic || "a small win from this week", niche: p.niche };
  const postParams = { topic: p.evalTopic || "a lesson from this week", length: "medium", niche: p.niche };

  let planText = "", capText = "", postText = "";
  try { planText = await generate(dispatch("plan",      planParams, p, null, {}, {}, [], null, null, null)); } catch (e) { console.error(`${p.name} plan:`, e.message); }
  try { capText  = await generate(dispatch("caption",   capParams,  p, null, {}, {}, [], null, null, null)); } catch (e) { console.error(`${p.name} caption:`, e.message); }
  try { postText = await generate(dispatch("long_post", postParams, p, null, {}, {}, [], null, null, null)); } catch (e) { console.error(`${p.name} post:`, e.message); }

  const plan = tryParse(planText), cap = tryParse(capText), post = tryParse(postText);

  // ── E2: rationale swap test ────────────────────────────────────────────
  const rationales = planRationales(plan);
  const own = anchorsByName[p.name];
  let specific = 0, crossLeak = 0;
  for (const r of rationales) {
    const ownHits = hitCount(r, own);
    if (ownHits > 0) specific++;
    // cross-leak: names another profile's anchors but none of its own
    if (ownHits === 0) {
      for (const other of PROFILES) {
        if (other.name === p.name) continue;
        if (hitCount(r, anchorsByName[other.name]) > 0) { crossLeak++; break; }
      }
    }
  }
  const specificity = rationales.length ? specific / rationales.length : null;
  const crossLeakRate = rationales.length ? crossLeak / rationales.length : null;

  // ── E3: cross-feature voice consistency ────────────────────────────────
  const drifts = {};
  for (const [surface, parsed, gt] of [["plan", plan, "plan"], ["caption", cap, "caption"], ["post", post, "long_post"]]) {
    if (!parsed || !reference) { drifts[surface] = null; continue; }
    const vt = surfaceVoiceText(gt, parsed);
    const d = vt ? computeVoiceDrift(vt, reference) : null;
    drifts[surface] = d ? d.score : null;
  }
  const scored = Object.values(drifts).filter(v => v != null);
  const spread = scored.length >= 2 ? Math.max(...scored) - Math.min(...scored) : null;

  perProfile.push({
    profile: p.name, rationales: rationales.length,
    specificity, crossLeakRate, drifts, spread,
    parsed: { plan: !!plan, caption: !!cap, post: !!post },
  });

  const pct = v => v == null ? " n/a" : (v * 100).toFixed(0).padStart(3) + "%";
  const num = v => v == null ? "n/a" : v.toFixed(1);
  console.log(
    p.name.padEnd(22) +
    ` rationales:${String(rationales.length).padStart(2)}` +
    ` specific:${pct(specificity)}` +
    ` cross-leak:${pct(crossLeakRate)}` +
    ` drift[plan/cap/post]:${num(drifts.plan)}/${num(drifts.caption)}/${num(drifts.post)}` +
    ` spread:${num(spread)}`
  );
}

// ── Run summary ────────────────────────────────────────────────────────────
const spec = perProfile.map(r => r.specificity).filter(v => v != null);
const leak = perProfile.map(r => r.crossLeakRate).filter(v => v != null);
const sprd = perProfile.map(r => r.spread).filter(v => v != null);
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

const summary = {
  at: new Date().toISOString(), label: LABEL,
  avg_specificity: avg(spec), avg_cross_leak: avg(leak), avg_voice_spread: avg(sprd),
  profiles: perProfile,
};
console.log("\n── Persona eval summary (" + LABEL + ") ──");
console.log(`  Rationale specificity (higher better):  ${avg(spec) != null ? (avg(spec) * 100).toFixed(0) + "%" : "n/a"}`);
console.log(`  Rationale cross-leak  (lower better):   ${avg(leak) != null ? (avg(leak) * 100).toFixed(0) + "%" : "n/a"}`);
console.log(`  Voice spread across surfaces (lower better): ${avg(sprd) != null ? avg(sprd).toFixed(1) : "n/a"}`);
console.log("\nNote: VIRL Scan meta-text (E3's third surface) needs a real image and is a manual check — see the PR.");

appendFileSync(new URL("./persona-eval-history.jsonl", import.meta.url), JSON.stringify(summary) + "\n");
console.log("Appended to scripts/persona-eval-history.jsonl");
