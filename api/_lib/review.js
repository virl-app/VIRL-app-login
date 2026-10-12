// [PR3] The monthly review: what this creator's own rows say, and what the
// strategist proposes because of it.
//
//   reviewPeriod(profile, lastReview)         → { start, end } ISO dates
//   gatherReviewStats(userId, start, end)     → counts from posts + voice_checks
//   isReviewDue(stats, start, now)            → 30 days and 4 posted posts
//   generateReview(user, profile, env)        → inserts a strategy_reviews row
//
// Every query here is filtered by user_id. Nothing crosses accounts; the
// review is this creator's data read back to them, with proposals that each
// name the rows they rest on.

import { callClaude, extractJsonObject } from "./anthropic.js";
import { recordUsage, recordEvent } from "./usage.js";
import { applyPatch, diffStrategies } from "./json-patch.js";
import { validateStrategy, normalisePillarShares } from "./strategy-schema.js";
import { reviewPrompt } from "./strategist-prompts.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
export const REVIEW_MODEL  = "claude-opus-5-5";
export const REVIEW_MIN_DAYS   = 30;
export const REVIEW_MIN_POSTED = 4;
export const VOICE_RATE_FLOOR  = 0.6;

function sb() { return { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" }; }
async function rows(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sb() });
  if (!r.ok) throw new Error("read " + path.split("?")[0] + " " + r.status);
  return r.json();
}
function dateISO(d) { return new Date(d).toISOString().slice(0, 10); }
function inc(map, key, field) { if (!key) return; map[key] = map[key] || { planned: 0, posted: 0, skipped: 0 }; map[key][field]++; }

export async function fetchLatestReview(userId) {
  const list = await rows(`strategy_reviews?user_id=eq.${userId}&order=created_at.desc&limit=1`);
  return list[0] || null;
}
export async function fetchOpenReview(userId) {
  const list = await rows(`strategy_reviews?user_id=eq.${userId}&status=eq.open&order=created_at.desc&limit=1`);
  return list[0] || null;
}
export async function fetchRecentReviews(userId, n) {
  return rows(`strategy_reviews?user_id=eq.${userId}&order=created_at.desc&limit=${n || 3}&select=id,period_start,period_end,voice_rate,status,created_at`);
}

// The period a review covers: from the last review's end (or the strategy
// build) to today.
export function reviewPeriod(profile, lastReview, now) {
  const end = dateISO(now || Date.now());
  let start = lastReview && lastReview.period_end ? lastReview.period_end : (profile.strategy_built_at ? dateISO(profile.strategy_built_at) : null);
  if (!start) start = dateISO(Date.now() - REVIEW_MIN_DAYS * 86400000);
  return { start, end };
}

export function isReviewDue(stats, start, now) {
  const days = (Date.parse(dateISO(now || Date.now())) - Date.parse(start)) / 86400000;
  return days >= REVIEW_MIN_DAYS && stats.posted >= REVIEW_MIN_POSTED;
}

// Counts the review is written from. Posts are matched on week_start inside
// the period; voice checks on created_at.
export async function gatherReviewStats(userId, start, end) {
  const posts = await rows(`posts?user_id=eq.${userId}&week_start=gte.${start}&week_start=lte.${end}&select=card_key,week_start,day,title,platform,format,pillar,pillar_role,status,posted_at,skip_reason,self_result,attributed_result,edits_made,is_rework,rendered,insights&order=week_start.asc`);
  const checks = await rows(`voice_checks?user_id=eq.${userId}&created_at=gte.${start}T00:00:00Z&select=picked_fingerprint`);
  const s = {
    period: { start, end }, planned: posts.length, posted: 0, skipped: 0, byReason: {},
    byPillar: {}, byRole: {}, byFormat: {}, byPlatform: {},
    selfResults: { flopped: 0, okay: 0, popped: 0 }, popped: [], flopped: [],
    attributed: [], attributedCounts: {},
    insights: { count: 0, reach: 0, saves: 0, shares: 0, profile_visits: 0, dms: 0, top: null },
    editsMade: 0, renderedPosted: 0, reworkPosted: 0, weeksActive: 0, weeksPlanned: 0,
    voice: { checks: checks.length, pickedFingerprint: checks.filter(c => c.picked_fingerprint).length, rate: null },
  };
  const weeks = {};
  for (const p of posts) {
    weeks[p.week_start] = weeks[p.week_start] || { posted: 0 };
    const posted = p.status === "posted";
    inc(s.byPillar, p.pillar, "planned"); inc(s.byRole, p.pillar_role, "planned"); inc(s.byFormat, p.format, "planned"); inc(s.byPlatform, p.platform, "planned");
    if (posted) {
      s.posted++; weeks[p.week_start].posted++;
      inc(s.byPillar, p.pillar, "posted"); inc(s.byRole, p.pillar_role, "posted"); inc(s.byFormat, p.format, "posted"); inc(s.byPlatform, p.platform, "posted");
      if (p.edits_made) s.editsMade++;
      if (p.rendered) s.renderedPosted++;
      if (p.is_rework) s.reworkPosted++;
      if (p.self_result && s.selfResults[p.self_result] != null) {
        s.selfResults[p.self_result]++;
        if (p.self_result === "popped" && s.popped.length < 5) s.popped.push({ title: p.title, pillar: p.pillar, format: p.format });
        if (p.self_result === "flopped" && s.flopped.length < 5) s.flopped.push({ title: p.title, pillar: p.pillar, format: p.format });
      }
      if (p.attributed_result) {
        s.attributedCounts[p.attributed_result] = (s.attributedCounts[p.attributed_result] || 0) + 1;
        if (s.attributed.length < 10) s.attributed.push({ title: p.title, pillar: p.pillar, format: p.format, result: p.attributed_result });
      }
      if (p.insights && typeof p.insights === "object") {
        s.insights.count++;
        for (const k of ["reach", "saves", "shares", "profile_visits", "dms"]) if (Number.isFinite(p.insights[k])) s.insights[k] += p.insights[k];
        if (Number.isFinite(p.insights.reach) && (!s.insights.top || p.insights.reach > s.insights.top.reach)) s.insights.top = { title: p.title, reach: p.insights.reach, pillar: p.pillar, format: p.format };
      }
    } else if (p.status === "skipped") {
      s.skipped++;
      inc(s.byPillar, p.pillar, "skipped"); inc(s.byRole, p.pillar_role, "skipped"); inc(s.byFormat, p.format, "skipped");
      if (p.skip_reason) s.byReason[p.skip_reason] = (s.byReason[p.skip_reason] || 0) + 1;
    }
  }
  s.weeksPlanned = Object.keys(weeks).length;
  s.weeksActive = Object.keys(weeks).filter(w => weeks[w].posted > 0).length;
  if (checks.length) s.voice.rate = s.voice.pickedFingerprint / checks.length;
  return s;
}

// Renders the stats as plain lines the model reads. Each line is a fact the
// review may cite; nothing else is offered as evidence.
export function statsToLines(s) {
  const L = [];
  const pct = (a, b) => b ? Math.round(100 * a / b) + "%" : "n/a";
  L.push(`Period ${s.period.start} to ${s.period.end}: ${s.planned} posts planned across ${s.weeksPlanned} weeks, ${s.posted} marked posted (${pct(s.posted, s.planned)}), ${s.skipped} skipped. Weeks with at least one post: ${s.weeksActive} of ${s.weeksPlanned}.`);
  const reasons = Object.keys(s.byReason).map(k => `${({ no_time: "no time", not_me: "didn't feel like them", didnt_know_how: "didn't know how" })[k] || k} ${s.byReason[k]}`);
  if (reasons.length) L.push("Skip reasons: " + reasons.join(", ") + ".");
  const bp = Object.keys(s.byPillar).map(k => `${k} [${s.byPillar[k].posted} of ${s.byPillar[k].planned} posted${s.byPillar[k].skipped ? ", " + s.byPillar[k].skipped + " skipped" : ""}]`);
  if (bp.length) L.push("By pillar: " + bp.join("; ") + ".");
  const br = Object.keys(s.byRole).map(k => `${k} ${s.byRole[k].posted}/${s.byRole[k].planned}`);
  if (br.length) L.push("By pillar role (posted/planned): " + br.join(", ") + ".");
  const bf = Object.keys(s.byFormat).map(k => `${k} ${s.byFormat[k].posted}/${s.byFormat[k].planned}`);
  if (bf.length) L.push("By format (posted/planned): " + bf.join(", ") + ".");
  const bpl = Object.keys(s.byPlatform).map(k => `${k} ${s.byPlatform[k].posted}/${s.byPlatform[k].planned}`);
  if (bpl.length > 1) L.push("By platform (posted/planned): " + bpl.join(", ") + ".");
  const sr = s.selfResults;
  if (sr.flopped + sr.okay + sr.popped > 0) L.push(`Self-reported: ${sr.popped} popped, ${sr.okay} okay, ${sr.flopped} flopped.` + (s.popped.length ? " Popped: " + s.popped.map(p => `"${p.title}" (${p.pillar || "no pillar"}, ${p.format || "?"})`).join(", ") + "." : "") + (s.flopped.length ? " Flopped: " + s.flopped.map(p => `"${p.title}" (${p.pillar || "no pillar"}, ${p.format || "?"})`).join(", ") + "." : ""));
  const ac = Object.keys(s.attributedCounts).map(k => `${({ dm: "DM", booking: "booking or sale", new_client: "new client", brand_inquiry: "brand inquiry", other: "other" })[k] || k} ${s.attributedCounts[k]}`);
  if (ac.length) L.push("Attributed results (their taps): " + ac.join(", ") + ". Posts: " + s.attributed.map(a => `"${a.title}" → ${a.result}${a.pillar ? " (" + a.pillar + ")" : ""}`).join("; ") + ".");
  else L.push("Attributed results: none tapped yet.");
  if (s.insights.count) L.push(`Insights screenshots on ${s.insights.count} posts: reach ${s.insights.reach}, saves ${s.insights.saves}, shares ${s.insights.shares}, profile visits ${s.insights.profile_visits}, DMs ${s.insights.dms}.` + (s.insights.top ? ` Highest reach: "${s.insights.top.title}" (${s.insights.top.reach}${s.insights.top.pillar ? ", " + s.insights.top.pillar : ""}).` : ""));
  else L.push("Insights screenshots: none uploaded; no platform numbers this period.");
  L.push(`Voice edits before posting: ${s.editsMade} of ${s.posted} posted. Rendered static posts posted: ${s.renderedPosted}. Reworks posted: ${s.reworkPosted}.`);
  if (s.voice.checks) L.push(`Voice checks: picked the caption written with their voice fingerprint ${s.voice.pickedFingerprint} of ${s.voice.checks} times.`);
  else L.push("Voice checks: none answered this period.");
  return L;
}

// Dry-run each proposal's patch so Accept can never produce an invalid
// strategy; proposals that don't apply cleanly are dropped, not shown.
export function validateProposals(strategy, proposals) {
  const { research: r0, quality: q0, omit: o0, ...core } = strategy || {};
  const out = [];
  for (const p of (Array.isArray(proposals) ? proposals : []).slice(0, 3)) {
    if (!p || typeof p !== "object" || !Array.isArray(p.changes) || !p.changes.length) continue;
    const title = String(p.title || "").trim().slice(0, 120);
    const evidence = String(p.evidence || "").trim().slice(0, 400);
    if (!title || !evidence) continue;
    try {
      const next = normalisePillarShares(applyPatch(core, p.changes));
      if (validateStrategy(next).length) continue;
      const diff = diffStrategies(core, next);
      if (!diff.length) continue;
      out.push({ title, evidence, note: String(p.note || "").trim().slice(0, 300), changes: p.changes, diff, decision: null });
    } catch (e) { /* skip */ }
  }
  return out;
}

export async function generateReview(user, profile, opts) {
  const o = opts || {};
  const last = await fetchLatestReview(user.id);
  const { start, end } = reviewPeriod(profile, last, o.now);
  const stats = await gatherReviewStats(user.id, start, end);
  if (!o.force && !isReviewDue(stats, start, o.now)) return { due: false, stats, period: { start, end } };
  const recent = await fetchRecentReviews(user.id, 2);
  const prevRates = recent.map(r => r.voice_rate).filter(v => v != null);
  const askFresh = stats.voice.rate != null && stats.voice.rate < VOICE_RATE_FLOOR && prevRates.length >= 1 && prevRates[0] < VOICE_RATE_FLOOR;

  const { system, prompt } = reviewPrompt({ strategy: profile.strategy, lines: statsToLines(stats), notes: profile.strategist_notes || [], prevRates, askFresh });
  const res = await callClaude({ system, prompt, model: REVIEW_MODEL, maxTokens: 3500, effort: "medium", fallbacks: true });
  if (!res) throw new Error("review model unavailable");
  await recordUsage(user.id, { generationType: "strategist_review", model: res.model || REVIEW_MODEL, usage: res.usage, stopReason: res.stopReason });
  const parsed = extractJsonObject(res.text) || {};
  const review = {
    opening:   String(parsed.opening || "").trim().slice(0, 1200),
    findings:  (Array.isArray(parsed.findings) ? parsed.findings : []).slice(0, 6).map(f => ({ text: String((f && f.text) || "").slice(0, 300), evidence: String((f && f.evidence) || "").slice(0, 300) })).filter(f => f.text),
    proposals: validateProposals(profile.strategy, parsed.proposals),
    voice_line: String(parsed.voice_line || "").trim().slice(0, 300),
    ask_fresh_sample: !!askFresh,
    sources: { posts: stats.planned, insights: stats.insights.count, voice_checks: stats.voice.checks },
  };
  if (!review.opening) throw new Error("review came back empty");
  const row = { user_id: user.id, period_start: start, period_end: end, review, stats, voice_rate: stats.voice.rate, status: review.proposals.length ? "open" : "done" };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/strategy_reviews`, { method: "POST", headers: Object.assign(sb(), { Prefer: "return=representation" }), body: JSON.stringify(row) });
  if (!r.ok) throw new Error("review write " + r.status + " " + (await r.text().catch(() => "")));
  const saved = (await r.json())[0];
  await recordEvent(user.id, "strategist_review_generated", { period_start: start, period_end: end, proposals: review.proposals.length, posted: stats.posted, voice_rate: stats.voice.rate, ask_fresh_sample: askFresh });
  return { due: true, review: saved, stats };
}

export async function updateReview(id, userId, patch) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/strategy_reviews?id=eq.${id}&user_id=eq.${userId}`, { method: "PATCH", headers: Object.assign(sb(), { Prefer: "return=representation" }), body: JSON.stringify(patch) });
  if (!r.ok) throw new Error("review update " + r.status);
  return (await r.json())[0];
}
