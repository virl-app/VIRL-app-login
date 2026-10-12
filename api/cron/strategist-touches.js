// [PR2] The strategist's clock. Runs hourly and, for every account with a
// strategy and a content slot, does whichever of these is due in THAT
// creator's local time (profiles.timezone, captured from their browser;
// America/Chicago when unknown):
//
//   1. Autogen (opt-in, profiles.plan_autogen): at 18:00 the evening before
//      the slot, generate the week's plan through /api/chat under the cron
//      identity, store it the way the client would (plans, plan_history,
//      posts) and send "Your week's planned" with the note and the first
//      post's caption.
//   2. Slot reminder: at the slot hour on the slot day, one email with the
//      first unposted post's caption and a deep link. One reminder, not a
//      sequence.
//   3. Days one and three after onboarding: "Did you post it? Tap when you
//      do." with the first post, then the second.
//
// Everything goes through the existing transactional path (sendEmail,
// marketing:false, email_sends dedupe). No Loops flows are touched. The
// legacy evening-before posting_reminder skips these accounts so nobody
// gets two reminders for one slot.

import { cronAuthorized } from "../_lib/cron-auth.js";
import { sendEmail, emailEnabled } from "../_lib/email-send.js";
import * as T from "../_lib/email-templates.js";
import { recordEvent } from "../_lib/usage.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET          = process.env.CRON_SECRET;
const APP_URL              = process.env.APP_URL || "https://app.govirl.ai";
const DEFAULT_TZ           = "America/Chicago";
const AUTOGEN_HOUR         = 18;

export const config = { maxDuration: 300 };

function sb(extra) { return Object.assign({ apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" }, extra || {}); }

// ── Local time ─────────────────────────────────────────────────────────────
const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export function localParts(date, tz) {
  let zone = tz || DEFAULT_TZ;
  let f;
  try { f = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "numeric", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }); }
  catch (e) { zone = DEFAULT_TZ; f = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "numeric", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }); }
  const parts = {};
  for (const p of f.formatToParts(date)) parts[p.type] = p.value;
  const hour = parseInt(parts.hour, 10) % 24;
  return { weekday: DAY_INDEX[parts.weekday] ?? 0, hour, dateISO: `${parts.year}-${parts.month}-${parts.day}`, tz: zone };
}
export function weekdayIndex(name) {
  const n = String(name || "").slice(0, 3).toLowerCase();
  const i = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(n);
  return i < 0 ? 0 : i;
}
// "9p", "9pm", "7:30 PM", "19:00", "evening" → hour (0-23). 19 when unreadable.
export function slotHour(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return 19;
  if (/morning/.test(t)) return 8;
  if (/lunch|noon|midday/.test(t)) return 12;
  if (/afternoon/.test(t)) return 15;
  if (/evening|night/.test(t)) return 19;
  const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(a|p|am|pm)?/);
  if (!m) return 19;
  let h = parseInt(m[1], 10);
  const ap = m[3] ? m[3][0] : "";
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  if (!ap && h >= 1 && h <= 9) h += 12; // "7" with no am/pm is a 7pm content slot far more often than 7am
  return Math.max(0, Math.min(23, h));
}
function weekStartISO(dateISO, weekStartDay) {
  const d = new Date(dateISO + "T00:00:00Z");
  const anchor = Number.isInteger(weekStartDay) ? weekStartDay : 0;
  const back = (d.getUTCDay() - anchor + 7) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// ── Data ───────────────────────────────────────────────────────────────────
async function fetchStrategistProfiles() {
  const cols = "id,name,content_slot,timezone,plan_autogen,strategy,strategy_built_at,onboarding_answers,week_start_day,niche_pack,legacy_niche,my_platforms";
  const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?strategy=not.is.null&select=${cols}`, { headers: sb() });
  if (!r.ok) throw new Error("profiles " + r.status);
  return r.json();
}
async function fetchEmail(userId) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers: sb() });
    if (!r.ok) return null;
    const u = await r.json();
    return u.email || null;
  } catch (e) { return null; }
}
async function fetchPlan(userId) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/plans?user_id=eq.${userId}&select=cards,strategy,expires_at,updated_at`, { headers: sb() });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}
async function fetchPosts(userId, weekStart) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/posts?user_id=eq.${userId}&week_start=eq.${weekStart}&select=card_key,status`, { headers: sb() });
  if (!r.ok) return [];
  return r.json();
}
async function upsert(table, rows, onConflict) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST", headers: sb({ Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify(rows),
  });
  if (!r.ok) console.warn("[strategist-touches] upsert", table, r.status, (await r.text().catch(() => "")).slice(0, 200));
  return r.ok;
}

function cardKey(c) { return String(c.title || "") + String(c.day || ""); }
function postLink(key) { return APP_URL + "/?tab=plan&post=" + encodeURIComponent(key); }
function firstUnposted(cards, posts) {
  const done = new Set(posts.filter(p => p.status !== "planned").map(p => p.card_key));
  return (cards || []).find(c => c && c.title && !done.has(cardKey(c))) || (cards || [])[0] || null;
}

// ── Autogen ────────────────────────────────────────────────────────────────
const OLD_GOAL = { clients: "Generate leads", income: "Sell products", authority: "Grow my following", community: "Build community", launch: "Drive traffic to my site or listings", unsure: "Grow my following" };
function formatsFor(strategy) {
  const out = new Set();
  for (const f of (strategy.formats || [])) {
    const t = String(f).toLowerCase();
    if (/camera|talking/.test(t)) out.add("Talking-head video");
    if (/carousel|static|quote|card/.test(t)) out.add("Carousel");
    if (/text post|text-first|linkedin post|thread/.test(t)) out.add("Text post");
    if (/voiceover|b-roll|broll|clip/.test(t)) out.add("Aesthetic B-roll");
    if (/tutorial|how to|how-to/.test(t)) out.add("Tutorial");
    if (/day in/.test(t)) out.add("Day in my life");
  }
  if (!out.size) { out.add("Talking-head video"); out.add("Carousel"); out.add("Text post"); }
  return Array.from(out);
}
function followersFor(profile, primary) {
  const sizes = profile.onboarding_answers && profile.onboarding_answers.reality && profile.onboarding_answers.reality.sizes || {};
  const s = sizes[primary] || "";
  return s === "10k+" ? "20K-100K" : s === "1k_10k" ? "1K-5K" : "Under 1K";
}
function clientNowFor(tz) {
  const d = new Date();
  const lp = localParts(d, tz);
  return { iso: lp.dateISO, weekday: lp.weekday, year: parseInt(lp.dateISO.slice(0, 4), 10), hour: lp.hour, minute: 0, localTime: (lp.hour % 12 || 12) + ":00 " + (lp.hour < 12 ? "AM" : "PM"), tz: lp.tz };
}
function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16); });
}

async function generatePlan(profile, tz) {
  const s = profile.strategy;
  const platforms = [s.platform.primary].concat(s.platform.rework || []).map(p => p === "YouTube Shorts" ? "YouTube" : p).filter(p => p !== "Other");
  const params = {
    platforms, niche: profile.niche_pack || "Creators & Personal Brands", legacyNiche: profile.legacy_niche || undefined,
    goal: OLD_GOAL[s.goal && s.goal.primary] || "Grow my following",
    formats: formatsFor(s), followers: followersFor(profile, s.platform.primary),
    context: "", weekContext: "", weekIntensity: "standard", isRegen: false, observances: [],
    currentWeekStart: weekStartISO(localParts(new Date(), tz).dateISO, profile.week_start_day),
    weekStartDay: profile.week_start_day || 0, clientNow: clientNowFor(tz), planJobId: uuid(),
  };
  const r = await fetch(`${APP_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "text/event-stream", "Authorization": `Bearer ${CRON_SECRET}`, "x-virl-cron-user": profile.id },
    body: JSON.stringify({ generationType: "plan", params }),
  });
  if (!r.ok) throw new Error("chat " + r.status + " " + (await r.text().catch(() => "")).slice(0, 200));
  // Consume the SSE stream the way the client does: `text` deltas build the
  // JSON, `reset` clears it, `error` aborts, `meta` ends it.
  const raw = await r.text();
  let text = "", meta = null, err = null;
  for (const chunk of raw.split("\n\n")) {
    const ev = (chunk.match(/^event: (.+)$/m) || [])[1];
    const data = (chunk.match(/^data: (.+)$/m) || [])[1];
    if (!ev || !data) continue;
    let d = {}; try { d = JSON.parse(data); } catch (e) {}
    if (ev === "text")  text += d.delta || "";
    if (ev === "reset") text = "";
    if (ev === "meta")  meta = d;
    if (ev === "error") err = d.error || "error";
  }
  if (err) throw new Error(err);
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.cards) || !parsed.cards.length) throw new Error("empty plan");
  return { parsed, meta, weekStart: params.currentWeekStart };
}

async function storePlan(profile, parsed, meta, weekStart, tz) {
  const now = new Date();
  // Expiry: the end of the creator's week, like computePlanExpiry client-side.
  const ws = new Date(weekStart + "T00:00:00Z");
  const expires = new Date(ws.getTime() + 7 * 86400000);
  const strategyObj = parsed.strategy && typeof parsed.strategy === "object" ? parsed.strategy : null;
  if (strategyObj) { strategyObj.week_note = parsed.week_note || ""; strategyObj.drift = parsed.drift || ""; strategyObj.daily_comments = parsed.daily_comments || null; }
  await upsert("plans", [{ user_id: profile.id, cards: parsed.cards, stats: parsed.stats || null, strategy: strategyObj, trends_snapshot: meta && meta.trendsSnapshot || null, rest_day_tips: Array.isArray(parsed.restDayTips) ? parsed.restDayTips : null, expires_at: expires.toISOString(), updated_at: now.toISOString() }], "user_id");
  await upsert("plan_history", [{ user_id: profile.id, week_start: weekStart, cards: parsed.cards, stats: parsed.stats || null, strategy: strategyObj }], "user_id,week_start");
  await upsert("posts", parsed.cards.filter(c => c && c.title).map(c => ({
    user_id: profile.id, week_start: weekStart, card_key: cardKey(c), day: c.day || null, title: c.title || null, platform: c.platform || null, format: c.format || null,
    pillar: c.pillar || null, pillar_role: ["reach", "trust", "connection", "convert"].includes(c.pillar_role) ? c.pillar_role : null,
    is_rework: !!c.is_rework, rendered: !!c.rendered, status: "planned", updated_at: now.toISOString(),
  })), "user_id,week_start,card_key");
}

// ── The hourly pass ────────────────────────────────────────────────────────
async function processProfile(p, counts) {
  const slot = p.content_slot && typeof p.content_slot === "object" ? p.content_slot : null;
  if (!slot || !p.strategy) return;
  const tz = p.timezone || DEFAULT_TZ;
  const now = new Date();
  const lp = localParts(now, tz);
  const slotDay = weekdayIndex(slot.weekday);
  const hour = slotHour(slot.time);
  const weekStart = weekStartISO(lp.dateISO, p.week_start_day);
  let email = null;
  const getEmail = async () => (email = email || await fetchEmail(p.id));

  // 1. Autogen the evening before the slot.
  if (p.plan_autogen && lp.weekday === (slotDay + 6) % 7 && lp.hour === AUTOGEN_HOUR) {
    const plan = await fetchPlan(p.id);
    const fresh = plan && plan.updated_at && (now.getTime() - Date.parse(plan.updated_at)) < 5 * 86400000;
    if (!fresh) {
      const to = await getEmail();
      try {
        const { parsed, meta, weekStart: ws } = await generatePlan(p, tz);
        await storePlan(p, parsed, meta, ws, tz);
        counts.autogen++;
        await recordEvent(p.id, "plan_autogenerated", { weekStart: ws, cards: parsed.cards.length, cost: meta && meta.cost });
        const first = parsed.cards[0];
        if (to) {
          const tpl = T.strategistPlanReady({ name: p.name, weekNote: parsed.week_note || "", card: first, link: postLink(cardKey(first)) });
          await sendEmail({ userId: p.id, to, template: "strategist_plan_ready", dedupeKey: `strategist_plan_ready_${ws}`, subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: false });
        }
      } catch (e) {
        counts.errors++;
        console.error("[strategist-touches] autogen failed", p.id, e && e.message);
        await recordEvent(p.id, "plan_autogen_failed", { error: String(e && e.message).slice(0, 200) });
      }
    }
  }

  // 2. The slot reminder.
  if (lp.weekday === slotDay && lp.hour === hour) {
    const plan = await fetchPlan(p.id);
    if (plan && Array.isArray(plan.cards) && plan.cards.length && !(plan.expires_at && Date.parse(plan.expires_at) < now.getTime())) {
      const posts = await fetchPosts(p.id, weekStart);
      const card = firstUnposted(plan.cards, posts);
      const to = await getEmail();
      if (card && to) {
        const tpl = T.slotReminder({ name: p.name, card, link: postLink(cardKey(card)) });
        const sent = await sendEmail({ userId: p.id, to, template: "slot_reminder", dedupeKey: `slot_reminder_${weekStart}`, subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: false });
        if (sent) { counts.reminders++; await recordEvent(p.id, "slot_reminder_sent", { weekStart, cardKey: cardKey(card) }); }
      }
    }
  }

  // 3. Days one and three after onboarding.
  const builtMs = p.strategy_built_at ? Date.parse(p.strategy_built_at) : NaN;
  if (Number.isFinite(builtMs)) {
    const hoursSince = (now.getTime() - builtMs) / 3600000;
    // Day 1: at the slot if the slot falls within 3 days of the build, else 24h later.
    const daysToSlot = (slotDay - lp.weekday + 7) % 7;
    const slotWithin3 = daysToSlot <= 3;
    const atSlotNow = lp.weekday === slotDay && lp.hour === hour;
    const day1Due = hoursSince >= 1 && hoursSince < 96 && (slotWithin3 ? atSlotNow : hoursSince >= 24);
    const day3Due = hoursSince >= 72 && hoursSince < 168 && lp.hour === hour;
    if (day1Due || day3Due) {
      const plan = await fetchPlan(p.id);
      const cards = plan && Array.isArray(plan.cards) ? plan.cards : [];
      const first = p.strategy.first_post ? { hook: p.strategy.first_post.hook, caption: p.strategy.first_post.caption, title: p.strategy.first_post.hook } : (cards[0] || null);
      const second = cards[1] || null;
      const to = await getEmail();
      if (to && day1Due && first) {
        const tpl = T.didYouPost({ name: p.name, card: first, link: APP_URL + "/?tab=strategy", dayNumber: 1 });
        const sent = await sendEmail({ userId: p.id, to, template: "did_you_post_day1", dedupeKey: "did_you_post_day1", subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: false });
        if (sent) { counts.touches++; await recordEvent(p.id, "did_you_post_sent", { day: 1 }); }
      }
      if (to && day3Due && second) {
        const tpl = T.didYouPost({ name: p.name, card: second, link: postLink(cardKey(second)), dayNumber: 3 });
        const sent = await sendEmail({ userId: p.id, to, template: "did_you_post_day3", dedupeKey: "did_you_post_day3", subject: tpl.subject, html: tpl.html, text: tpl.text, marketing: false });
        if (sent) { counts.touches++; await recordEvent(p.id, "did_you_post_sent", { day: 3 }); }
      }
    }
  }
}

export default async function handler(req, res) {
  if (!cronAuthorized(req, "strategist-touches")) return res.status(401).json({ error: "Unauthorized" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: "Server misconfigured." });
  if (!emailEnabled()) return res.status(200).json({ ok: true, skipped: "email_disabled" });
  const counts = { profiles: 0, autogen: 0, reminders: 0, touches: 0, errors: 0 };
  try {
    const profiles = await fetchStrategistProfiles();
    counts.profiles = profiles.length;
    for (const p of profiles) {
      try { await processProfile(p, counts); }
      catch (e) { counts.errors++; console.error("[strategist-touches]", p.id, e && e.message); }
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  return res.status(200).json(Object.assign({ ok: true }, counts));
}
