// [PR1] The strategist's endpoint. One function, five actions, all POST with
// a Bearer token and a JSON body { action, ... }:
//
//   heard       { goal, about } | { fromProfile: true }
//               → { heard: {...cards}, migrated?: {...} }      fast model
//   build       { answers }  → { strategy, version, quality }  strongest model
//   interpret   { text, section } → { strategy, version, diff, note, open_screen }
//   undo        { toVersion } → { strategy, version }
//   transcribe  { audioBase64, mimeType } → { text } | { text: null, reason }
//
// Gated on account_flags.strategist_v2. Nothing here costs credits: a
// strategy is built a handful of times per account, so the rate limit is the
// budget. Every model call lands in usage_events; every action lands in
// events tagged strategist_v2:true.

import { callClaude, extractJsonObject } from "./_lib/anthropic.js";
import { callPerplexity, tryParseJSON } from "./_lib/perplexity.js";
import { recordUsage, recordEvent, checkRateLimit } from "./_lib/usage.js";
import { checkOutput } from "./_lib/output-check.js";
import { applyPatch, diffStrategies } from "./_lib/json-patch.js";
import { STRATEGY_JSON_SCHEMA, validateStrategy, normalisePillarShares, PLATFORMS, GOALS } from "./_lib/strategy-schema.js";
import { heardPrompt, HEARD_SCHEMA, buildPrompt, buildRetryNote, interpretPrompt, voiceVariantPrompt } from "./_lib/strategist-prompts.js";
import { generateReview, fetchOpenReview, fetchLatestReview, updateReview, reviewPeriod, gatherReviewStats, isReviewDue, REVIEW_MIN_DAYS, REVIEW_MIN_POSTED } from "./_lib/review.js";
import { loadPlaybook } from "./_lib/playbook.js";
import { formatNicheModelForPrompt } from "./_lib/niche-playbook.js";
import { computeVoiceFingerprint, formatFingerprintForPrompt } from "./_lib/voice-drift.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ELEVENLABS_API_KEY   = process.env.ELEVENLABS_API_KEY;

// Model tiers (brief): strongest for the build and the interpreter, fast for
// chip inference and one-line notes.
export const STRATEGY_MODEL_STRONG = "claude-opus-5-5";
export const STRATEGY_MODEL_FAST   = "claude-haiku-5-5";

export const config = { maxDuration: 180 };

function sb() {
  return { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" };
}

async function getUser(req) {
  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_KEY } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? { id: u.id, email: u.email || "", admin: String(u.email || "").toLowerCase() === "laurenannedoty@gmail.com" } : null;
  } catch (e) { return null; }
}

async function flagOn(userId) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/account_flags?user_id=eq.${userId}&select=strategist_v2`, { headers: sb() });
    if (!r.ok) return false;
    const rows = await r.json();
    return !!(rows[0] && rows[0].strategist_v2);
  } catch (e) { return false; }
}

const PROFILE_COLS = "name,audience,voice,my_platforms,vibes,sample_caption,voice_samples,topics,purpose,off_limits,journey,known_for,pillars,emoji_pref,handles,post_freq,worked_well,personal_facts,never_assume,love_to_reference,city,business_website,offerings,service_area,ideal_client_problem,primary_cta,common_objections,niche_detail,legacy_niche,niche_pack,onboarding_answers,strategy,strategy_version,strategy_history,strategist_notes,content_slot,voice_sample,emoji_use,emoji_where,strategy_built_at,last_voice_check,voice_sample_asked_at";

async function getProfile(userId) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=${PROFILE_COLS}`, { headers: sb() });
  if (!r.ok) throw new Error("profile read failed " + r.status);
  const rows = await r.json();
  return rows[0] || {};
}

async function patchProfile(userId, patch) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
    method: "PATCH", headers: Object.assign(sb(), { Prefer: "return=minimal" }), body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error("profile write failed " + r.status + " " + (await r.text().catch(() => "")));
}

function str(v, max) { return typeof v === "string" ? v.trim().slice(0, max || 2000) : ""; }
function arr(v) { return Array.isArray(v) ? v : []; }

// ── Old profile → interview answers ("Meet your strategist") ──────────────
// Which of the 35 old fields map to which answer. Each mapped field carries
// source: "migrated" so the review can tell them from stated answers.
export function migrateProfile(p) {
  const about = [
    p.voice && "How I'd describe myself: " + p.voice,
    p.known_for && "Known for: " + p.known_for,
    p.journey && "Where I am: " + p.journey,
    p.niche_detail && "What I do exactly: " + p.niche_detail,
    p.offerings && "What I offer: " + p.offerings,
    p.topics && "What I talk about: " + p.topics,
    p.audience && "Who it's for: " + p.audience,
    p.ideal_client_problem && "The problem I solve: " + p.ideal_client_problem,
    p.service_area && "Where: " + p.service_area,
    p.city && !p.service_area && "City: " + p.city,
  ].filter(Boolean).join("\n");
  const sample = [p.sample_caption, ...arr(p.voice_samples)].filter(s => typeof s === "string" && s.trim()).join("\n\n");
  const notes = [p.worked_well && "What's worked: " + p.worked_well, p.never_assume && "Never assume: " + p.never_assume, p.personal_facts && "About me: " + p.personal_facts, p.love_to_reference && "I love to reference: " + p.love_to_reference].filter(Boolean);
  const platforms = arr(p.my_platforms).map(x => x === "YouTube" ? "YouTube Shorts" : x).filter(x => PLATFORMS.includes(x));
  return {
    about:      { value: about, source: "migrated" },
    platforms:  { value: platforms, source: "migrated" },
    sample:     { value: sample, source: "migrated" },
    tone:       { value: arr(p.vibes).slice(0, 3), source: "migrated" },
    off_limits: { value: str(p.off_limits), source: "migrated" },
    rules:      { value: str(p.common_objections) ? "" : "", source: "migrated" },
    path:       { value: [p.primary_cta, p.common_objections].filter(Boolean).join(" / "), source: "migrated" },
    notes:      { value: notes, source: "migrated" },
    emoji_use:  { value: p.emoji_pref === "Never" ? "none" : p.emoji_pref === "Always" ? "lots" : "few", source: "migrated" },
    niche_pack: { value: p.niche_pack || "", source: "migrated" },
  };
}

// ── Actions ───────────────────────────────────────────────────────────────
async function actionHeard(user, body, profile) {
  let goal  = GOALS.includes(body.goal) ? body.goal : "unsure";
  let about = str(body.about, 4000);
  let migrated = null;
  if (body.fromProfile) {
    migrated = migrateProfile(profile);
    about = migrated.about.value || about;
  }
  if (about.length < 10) return { status: 400, json: { error: "Tell me a little more first." } };

  const { system, prompt } = heardPrompt({ goal, about });
  const started = Date.now();
  const res = await Promise.race([
    callClaude({ system, prompt, model: STRATEGY_MODEL_FAST, maxTokens: 800, outputSchema: HEARD_SCHEMA, effort: "low" }),
    new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 4000)),
  ]);
  const ms = Date.now() - started;
  if (!res || res.timeout) {
    await recordEvent(user.id, "strategist_heard", { ok: false, ms, timeout: !!(res && res.timeout) });
    return { status: 200, json: { heard: null, fallback: true, migrated } };
  }
  await recordUsage(user.id, { generationType: "strategist_heard", model: res.model || STRATEGY_MODEL_FAST, usage: res.usage, stopReason: res.stopReason });
  let heard = null;
  try { heard = JSON.parse(res.text); } catch (e) { heard = extractJsonObject(res.text); }
  await recordEvent(user.id, "strategist_heard", { ok: !!heard, ms });
  return { status: 200, json: { heard, fallback: !heard, migrated } };
}

async function research(answers, user) {
  const h = (answers.heard || {});
  const platform = arr(answers.reality && answers.reality.platforms)[0] || "Instagram";
  const who = [h.identity, (h.items || []).join(", ")].filter(Boolean).join(" — ");
  const where = h.city ? " in " + h.city : "";
  const prompt = "I'm building a content strategy for: " + who + where + ".\n"
    + "Answer these with specifics from the last 60 days, each as a finding with its source URL:\n"
    + "1. The top questions people in this niche ask online right now (3 findings).\n"
    + "2. Formats gaining traction on " + platform + " for this kind of account (2 findings).\n"
    + "3. Seasonal or local hooks for the next 6 weeks" + where + " (2 findings).\n"
    + "Reply with JSON only: {\"findings\": [{\"finding\": \"one sentence, concrete\", \"source_url\": \"https://...\"}]}";
  const r = await callPerplexity({ prompt, model: "sonar-pro", maxTokens: 2000, searchRecency: "month", searchContextSize: "medium" });
  if (!r) return [];
  const parsed = tryParseJSON(r.text);
  const now = new Date().toISOString();
  const findings = parsed && Array.isArray(parsed.findings) ? parsed.findings : [];
  const out = findings
    .filter(f => f && typeof f.finding === "string" && f.finding.trim())
    .slice(0, 8)
    .map(f => ({ finding: f.finding.trim().slice(0, 400), source_url: typeof f.source_url === "string" ? f.source_url.slice(0, 300) : "", fetched_at: now }));
  await recordEvent(user.id, "strategist_research", { ok: out.length > 0, findings: out.length });
  return out;
}

function cleanAnswers(raw) {
  const a = raw || {};
  const goal = a.goal || {};
  const reality = a.reality || {};
  const voice = a.voice || {};
  return {
    goal:  { primary: GOALS.includes(goal.primary) ? goal.primary : "unsure", secondary: arr(goal.secondary).filter(g => GOALS.includes(g)).slice(0, 3) },
    about: str(a.about, 4000),
    heard: a.heard && typeof a.heard === "object" ? a.heard : {},
    reality: {
      platforms: arr(reality.platforms).filter(p => PLATFORMS.includes(p)),
      sizes:     reality.sizes && typeof reality.sizes === "object" ? reality.sizes : {},
      camera:    str(reality.camera, 40),
      time:      str(reality.time, 20),
      slot:      { weekday: str(reality.slot && reality.slot.weekday, 20), time: str(reality.slot && reality.slot.time, 40), place: str(reality.slot && reality.slot.place, 120) },
      other:     str(reality.other, 60),
    },
    voice: {
      sample:      str(voice.sample, 6000),
      tone:        arr(voice.tone).slice(0, 3).map(t => str(t, 40)),
      off_limits:  str(voice.off_limits, 500),
      rules:       str(voice.rules, 500),
      emoji_use:   ["none", "few", "lots"].includes(voice.emoji_use) ? voice.emoji_use : "few",
      emoji_where: ["end", "anywhere"].includes(voice.emoji_where) ? voice.emoji_where : "end",
    },
    sources: a.sources && typeof a.sources === "object" ? a.sources : {},
    label: str(a.label, 80),
  };
}

function playbookLinesFor(playbook, platforms) {
  const out = [];
  for (const p of platforms) {
    const e = playbook && playbook[p === "YouTube Shorts" ? "YouTube" : p];
    if (!e) continue;
    const bits = [];
    if (e.cadence)      bits.push("cadence " + e.cadence);
    if (e.peak_times)   bits.push("peak " + e.peak_times);
    if (e.hook_window)  bits.push("hook window " + e.hook_window);
    if (e.hashtag_count) bits.push("hashtags " + e.hashtag_count);
    if (arr(e.format_priority).length) bits.push("formats " + e.format_priority.join(", "));
    if (arr(e.top_signals).length) bits.push("signals " + e.top_signals.join(", "));
    if (bits.length) out.push(p + ": " + bits.join("; "));
  }
  return out.join("\n");
}

const PROSE_FIELDS = ["positioning", "opening_note", "path_to_results", "first_post"];

async function actionBuild(user, body, profile) {
  const rl = await checkRateLimit(user.id, "strategy_build", 2, 6);
  if (!rl.ok) return { status: 429, json: { error: "Give me a few minutes before another build." } };

  const answers = cleanAnswers(body.answers);
  if (!answers.about || answers.reality.platforms.length === 0) return { status: 400, json: { error: "I need who you are and at least one platform." } };

  const started = Date.now();
  const [findings, playbook] = await Promise.all([research(answers, user), loadPlaybook().catch(() => ({}))]);
  const fp = answers.voice.sample ? computeVoiceFingerprint(answers.voice.sample) : null;
  const extras = {
    fingerprint:     fp ? formatFingerprintForPrompt(fp) : "",
    nicheModel:      formatNicheModelForPrompt(profile.legacy_niche || profile.niche_pack || ""),
    playbookLines:   playbookLinesFor(playbook, answers.reality.platforms),
    existingProfile: body.includeProfile ? migrateProfile(profile).about.value : "",
  };
  const { system, prompt } = buildPrompt(answers, findings, extras);

  let strategy = null, quality = null, attempts = 0, lastFailures = [];
  while (attempts < 2 && !strategy) {
    attempts++;
    const res = await callClaude({
      system, prompt: prompt + (lastFailures.length ? buildRetryNote(lastFailures) : ""),
      // Measured on the first production build: high effort took 69s for
      // 5,100 output tokens against a 20-40s target. Medium is the next
      // step down; the rubric check still gates the output.
      model: STRATEGY_MODEL_STRONG, maxTokens: 8000, outputSchema: STRATEGY_JSON_SCHEMA, effort: "medium", fallbacks: true,
    });
    if (!res) break;
    await recordUsage(user.id, { generationType: "strategist_build", model: res.model || STRATEGY_MODEL_STRONG, usage: res.usage, stopReason: res.stopReason });
    let candidate = null;
    try { candidate = JSON.parse(res.text); } catch (e) { candidate = extractJsonObject(res.text); }
    if (!candidate) continue;
    normalisePillarShares(candidate);
    const problems = validateStrategy(candidate);
    if (problems.length) { lastFailures = problems.map(p => ({ item: "FORMAT", note: "invalid field " + p })); continue; }
    // Rubric + anti-slop on the prose fields, fast model.
    const prose = {}; for (const k of PROSE_FIELDS) prose[k] = candidate[k];
    const check = await checkOutput(prose, { artifact: "strategy", multi: true, model: STRATEGY_MODEL_FAST, context: answers.voice.sample ? "VOICE SAMPLE:\n" + answers.voice.sample.slice(0, 1500) : "" });
    quality = { pass: check.pass, attempts, banned: check.banned.hits, rubric: check.rubric ? check.rubric.failures : null };
    if (check.pass || attempts >= 2) { strategy = candidate; break; }
    lastFailures = [...check.banned.hits.map(h => ({ item: "STYLE", note: "remove: " + h })), ...((check.rubric && check.rubric.failures) || [])];
  }
  const ms = Date.now() - started;
  if (!strategy) {
    await recordEvent(user.id, "strategist_build", { ok: false, ms, attempts });
    return { status: 502, json: { error: "I couldn't finish your strategy just now. Try again in a minute." } };
  }
  strategy.research = findings;
  strategy.quality  = quality;
  // On a persistent rubric failure, display with the failing section omitted
  // and a note (brief). The client reads `omit`.
  strategy.omit = (!quality.pass && quality.rubric) ? quality.rubric.map(f => f.item.toLowerCase()) : [];

  const version = (profile.strategy_version || 0) + 1;
  const history = arr(profile.strategy_history);
  if (profile.strategy) history.push({ version: profile.strategy_version || 0, label: "Before rebuild", at: new Date().toISOString(), strategy: profile.strategy });
  const emojiPref = answers.voice.emoji_use === "none" ? "Never" : answers.voice.emoji_use === "lots" ? "Always" : "Sometimes";
  const sources = answers.sources;
  const onboarding = {
    goal: answers.goal, about: answers.about, heard: answers.heard, reality: answers.reality,
    voice: Object.assign({}, answers.voice, { sample: undefined }),
    sources, built_at: new Date().toISOString(),
  };
  const patch = {
    onboarding_answers: onboarding,
    strategy, strategy_version: version, strategy_history: history.slice(-20),
    strategy_built_at: new Date().toISOString(),
    content_slot: answers.reality.slot,
    emoji_use: answers.voice.emoji_use, emoji_where: answers.voice.emoji_where, emoji_pref: emojiPref,
  };
  if (answers.voice.sample) patch.voice_sample = answers.voice.sample;
  // Keep the columns the old generation path still reads in step, without
  // overwriting what an existing account typed there.
  if (!arr(profile.my_platforms).length) patch.my_platforms = answers.reality.platforms.map(p => p === "YouTube Shorts" ? "YouTube" : p).filter(p => p !== "Other");
  if (!profile.off_limits && answers.voice.off_limits) patch.off_limits = answers.voice.off_limits;
  if (!arr(profile.voice_samples).length && !profile.sample_caption && answers.voice.sample) patch.voice_samples = [answers.voice.sample.slice(0, 2000)];
  if (!profile.audience && arr(answers.heard.audience).length) patch.audience = answers.heard.audience.join(", ");
  await patchProfile(user.id, patch);
  await recordEvent(user.id, "strategist_build", { ok: true, ms, attempts, rubric_pass: quality.pass, research: findings.length, version, label: answers.label || "" });
  return { status: 200, json: { strategy, version, quality } };
}

async function actionInterpret(user, body, profile) {
  const text = str(body.text, 1500);
  const section = str(body.section, 40);
  if (!text) return { status: 400, json: { error: "Say what's off, in your words." } };
  if (!profile.strategy) return { status: 400, json: { error: "There's no strategy to change yet." } };

  const { system, prompt } = interpretPrompt({ strategy: profile.strategy, section, text, notes: arr(profile.strategist_notes) });
  const res = await callClaude({ system, prompt, model: STRATEGY_MODEL_STRONG, maxTokens: 2500, effort: "medium", fallbacks: true });
  if (!res) return { status: 502, json: { error: "I couldn't read that just now. Try again." } };
  await recordUsage(user.id, { generationType: "strategist_interpret", model: res.model || STRATEGY_MODEL_STRONG, usage: res.usage, stopReason: res.stopReason });
  const parsed = extractJsonObject(res.text) || {};
  const changes = arr(parsed.changes);
  const note = str(parsed.note, 400) || "I kept it as it was.";
  const openScreen = Number.isInteger(parsed.open_screen) && parsed.open_screen >= 1 && parsed.open_screen <= 5 ? parsed.open_screen : null;

  const notes = arr(profile.strategist_notes).concat([text]).slice(-50);
  let next = null, diff = [];
  if (changes.length) {
    try {
      const { research: r0, quality: q0, omit: o0, ...core } = profile.strategy;
      next = normalisePillarShares(applyPatch(core, changes));
      const problems = validateStrategy(next);
      if (problems.length) { next = null; }
      else {
        next.research = r0 || []; next.quality = q0 || null; next.omit = o0 || [];
        diff = diffStrategies(core, next);
      }
    } catch (e) { next = null; }
  }
  if (!next) {
    await patchProfile(user.id, { strategist_notes: notes });
    await recordEvent(user.id, "strategist_not_quite_right", { section, words: text.split(/\s+/).length, changes: 0, open_screen: openScreen });
    return { status: 200, json: { strategy: profile.strategy, version: profile.strategy_version || 0, diff: [], note: changes.length ? "I couldn't apply that cleanly, so I left the strategy as it was. " + note : note, open_screen: openScreen } };
  }
  const version = (profile.strategy_version || 0) + 1;
  const history = arr(profile.strategy_history);
  history.push({ version: profile.strategy_version || 0, label: text.slice(0, 80), at: new Date().toISOString(), strategy: profile.strategy });
  await patchProfile(user.id, { strategy: next, strategy_version: version, strategy_history: history.slice(-20), strategist_notes: notes });
  await recordEvent(user.id, "strategist_not_quite_right", { section, words: text.split(/\s+/).length, changes: diff.length, open_screen: openScreen, version });
  return { status: 200, json: { strategy: next, version, diff, note, open_screen: openScreen } };
}

async function actionUndo(user, body, profile) {
  const history = arr(profile.strategy_history);
  if (!history.length) return { status: 400, json: { error: "Nothing to undo." } };
  const target = Number.isInteger(body.toVersion) ? history.find(h => h.version === body.toVersion) : history[history.length - 1];
  if (!target || !target.strategy) return { status: 400, json: { error: "That version isn't here." } };
  const version = (profile.strategy_version || 0) + 1;
  const nextHistory = history.concat([{ version: profile.strategy_version || 0, label: "Undone", at: new Date().toISOString(), strategy: profile.strategy }]).slice(-20);
  await patchProfile(user.id, { strategy: target.strategy, strategy_version: version, strategy_history: nextHistory });
  await recordEvent(user.id, "strategist_undo", { to: target.version, version });
  return { status: 200, json: { strategy: target.strategy, version } };
}

// [PR3] The monthly review.
//   mode "get"      → the open review if any, else whether one is due
//   mode "generate" → writes one when due (force only for admins testing)
//   mode "decide"   → accept or keep one proposal; accept applies the patch
//                     through the same version + history path as interpret,
//                     so Undo on the strategy page works on it too.
async function actionReview(user, body, profile) {
  const mode = str(body.mode, 12) || "get";
  if (!profile.strategy) return { status: 400, json: { error: "There's no strategy to review yet." } };
  if (mode === "get" || mode === "generate") {
    const open = await fetchOpenReview(user.id);
    if (open) return { status: 200, json: { review: open } };
    const last = await fetchLatestReview(user.id);
    const { start, end } = reviewPeriod(profile, last);
    const stats = await gatherReviewStats(user.id, start, end);
    const due = isReviewDue(stats, start);
    if (mode === "get" && !due) return { status: 200, json: { review: null, last: last ? { id: last.id, period_end: last.period_end, created_at: last.created_at } : null, due: false, progress: { posted: stats.posted, needPosted: REVIEW_MIN_POSTED, days: Math.floor((Date.now() - Date.parse(start)) / 86400000), needDays: REVIEW_MIN_DAYS } } };
    if (mode === "get" && due) {
      // Due and nothing open: write it now so the creator sees it the first
      // time they open the app after the month, Monday or not.
      const out = await generateReview(user, profile);
      return { status: 200, json: { review: out.review } };
    }
    const rl = await checkRateLimit(user.id, "strategy_review", 1, 3);
    if (!rl.ok) return { status: 429, json: { error: "One review at a time." } };
    const out = await generateReview(user, profile, { force: !!body.force && !!user.admin });
    if (!out.due) return { status: 200, json: { review: null, due: false, progress: { posted: out.stats.posted, needPosted: REVIEW_MIN_POSTED } } };
    return { status: 200, json: { review: out.review } };
  }
  if (mode === "decide") {
    const id = str(body.reviewId, 40);
    const idx = Number.isInteger(body.index) ? body.index : -1;
    const accept = !!body.accept;
    const open = await fetchOpenReview(user.id);
    if (!open || open.id !== id) return { status: 400, json: { error: "That review isn't open." } };
    const review = open.review || {};
    const proposals = arr(review.proposals);
    const p = proposals[idx];
    if (!p || p.decision) return { status: 400, json: { error: "That proposal is already decided." } };
    let strategy = profile.strategy, version = profile.strategy_version || 0, diff = [], note = "";
    if (accept) {
      const { research: r0, quality: q0, omit: o0, ...core } = profile.strategy;
      let next = null;
      try {
        next = normalisePillarShares(applyPatch(core, p.changes));
        if (validateStrategy(next).length) next = null;
      } catch (e) { next = null; }
      if (!next) return { status: 400, json: { error: "I couldn't apply that cleanly against your current strategy, so I left it as it was." } };
      next.research = r0 || []; next.quality = q0 || null; next.omit = o0 || [];
      diff = diffStrategies(core, next);
      version = (profile.strategy_version || 0) + 1;
      const history = arr(profile.strategy_history);
      history.push({ version: profile.strategy_version || 0, label: "Review: " + p.title, at: new Date().toISOString(), strategy: profile.strategy });
      await patchProfile(user.id, { strategy: next, strategy_version: version, strategy_history: history.slice(-20) });
      strategy = next;
      note = p.note || ("Applied: " + p.title + ".");
    } else {
      note = "Kept as it was.";
    }
    proposals[idx] = Object.assign({}, p, { decision: accept ? "accepted" : "kept", decided_at: new Date().toISOString(), applied_version: accept ? version : null });
    const allDecided = proposals.every(x => x.decision);
    const saved = await updateReview(open.id, user.id, { review: Object.assign({}, review, { proposals }), status: allDecided ? "done" : "open", decided_at: allDecided ? new Date().toISOString() : null });
    await recordEvent(user.id, accept ? "strategist_review_accepted" : "strategist_review_kept", { review_id: open.id, index: idx, title: p.title, version });
    return { status: 200, json: { review: saved, strategy, version, diff, note } };
  }
  return { status: 400, json: { error: "Unknown review mode." } };
}

// [PR3] Voice check: the neutral twin of a plan caption (fast model).
async function actionVoiceVariant(user, body) {
  const caption = str(body.caption, 2200);
  if (!caption) return { status: 400, json: { error: "No caption to work from." } };
  const { system, prompt } = voiceVariantPrompt({ caption, platform: str(body.platform, 30) });
  const res = await callClaude({ system, prompt, model: STRATEGY_MODEL_FAST, maxTokens: 900, temperature: 0.4 });
  if (!res || !res.text) return { status: 502, json: { error: "I couldn't write the other version just now." } };
  await recordUsage(user.id, { generationType: "strategist_voice_variant", model: res.model || STRATEGY_MODEL_FAST, usage: res.usage, stopReason: res.stopReason });
  const variant = res.text.trim().replace(/^["“]|["”]$/g, "");
  if (!variant || variant === caption) return { status: 502, json: { error: "The other version came back the same." } };
  return { status: 200, json: { variant } };
}

async function actionTranscribe(user, body) {
  if (!ELEVENLABS_API_KEY) return { status: 200, json: { text: null, reason: "Voice notes aren't set up yet. Paste a few captions instead." } };
  const b64 = str(body.audioBase64, 12 * 1024 * 1024);
  const mime = str(body.mimeType, 60) || "audio/webm";
  if (!b64) return { status: 400, json: { error: "No audio." } };
  try {
    const bytes = Buffer.from(b64, "base64");
    const form = new FormData();
    form.append("model_id", "scribe_v1");
    form.append("file", new Blob([bytes], { type: mime }), "note." + (mime.split("/")[1] || "webm").split(";")[0]);
    const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": ELEVENLABS_API_KEY }, body: form });
    if (!r.ok) {
      console.warn("[transcribe] elevenlabs", r.status, (await r.text().catch(() => "")).slice(0, 200));
      await recordEvent(user.id, "strategist_transcribe", { ok: false, status: r.status });
      return { status: 200, json: { text: null, reason: "I couldn't hear that one. Try again or paste captions." } };
    }
    const j = await r.json();
    const text = str(j && j.text, 6000);
    await recordEvent(user.id, "strategist_transcribe", { ok: !!text, seconds: bytes.length / 16000 });
    return { status: 200, json: { text: text || null, reason: text ? null : "That came through empty." } };
  } catch (e) {
    return { status: 200, json: { text: null, reason: "I couldn't hear that one. Try again or paste captions." } };
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: "Server misconfigured." });
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Sign in required." });
  if (!(await flagOn(user.id))) return res.status(403).json({ error: "Not available on this account yet." });

  const rl = await checkRateLimit(user.id, "strategy", 8, 40);
  if (!rl.ok) { res.setHeader("Retry-After", rl.kind === "minute" ? "60" : "3600"); return res.status(429).json({ error: "Slow down a touch." }); }

  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const action = str(body.action, 20);
  try {
    let out;
    if (action === "transcribe") out = await actionTranscribe(user, body);
    else {
      const profile = await getProfile(user.id);
      if      (action === "heard")     out = await actionHeard(user, body, profile);
      else if (action === "build")     out = await actionBuild(user, body, profile);
      else if (action === "interpret") out = await actionInterpret(user, body, profile);
      else if (action === "undo")      out = await actionUndo(user, body, profile);
      else if (action === "review")    out = await actionReview(user, body, profile);
      else if (action === "voice_variant") out = await actionVoiceVariant(user, body);
      else return res.status(400).json({ error: "Unknown action." });
    }
    return res.status(out.status).json(out.json);
  } catch (e) {
    console.error("[strategy]", action, e && e.message);
    return res.status(500).json({ error: "Something went wrong on my side." });
  }
}
