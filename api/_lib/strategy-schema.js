// [PR1] The strategy JSON: what the build call returns and every later call
// reads. One shape, one place. The JSON schema below is handed to the model
// as a structured-output format so the build never comes back malformed, and
// `validateStrategy` re-checks what we store, since the interpreter applies
// patches that bypass the model's schema.
//
// Keep this schema inside what structured outputs accept: no min/max, no
// string length limits, every object `additionalProperties: false`.

export const PLATFORMS = ["TikTok", "Instagram", "Facebook", "LinkedIn", "X", "Threads", "YouTube Shorts", "Pinterest", "Other"];
// Pinterest is never primary in this sequence (brief: rework only).
export const PRIMARY_PLATFORMS = PLATFORMS.filter(p => p !== "Pinterest" && p !== "Other");
export const GOALS = ["clients", "income", "authority", "community", "launch", "unsure"];
export const GOAL_LABELS = {
  clients:   "Bring me clients or customers",
  income:    "Turn content into my income",
  authority: "Make me the go-to name in my field",
  community: "Grow a community around something I love",
  launch:    "Help me launch something new",
  unsure:    "I'm not sure yet, help me figure it out",
};
export const PILLAR_ROLES = ["reach", "trust", "connection", "convert"];
export const STAGES = ["start", "grow", "convert", "scale"];
export const MARKET_TYPES = ["local", "online", "both"];
export const CAMERA_COMFORT = ["love", "fine", "rather_not", "grow_into"];
export const TIME_PER_WEEK = ["1h", "2-3h", "4-6h", "7h+"];
export const PLATFORM_SIZES = ["new", "under_1k", "1k_10k", "10k+"];
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const str = { type: "string" };
const strArr = { type: "array", items: str };

export const STRATEGY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "goal", "identity", "edge", "audience", "struggle", "market", "price_band",
    "positioning", "platform", "stage", "pillars", "formats", "cadence",
    "path_to_results", "metrics", "guardrails", "opening_note", "still_learning",
    "first_post",
  ],
  properties: {
    goal: {
      type: "object", additionalProperties: false, required: ["primary", "secondary"],
      properties: { primary: { type: "string", enum: GOALS }, secondary: { type: "array", items: { type: "string", enum: GOALS } } },
    },
    identity:  str,   // "med spa owner in Franklin, TN"
    edge:      str,   // "straight-talking, shows exactly what happens" — "" if none stated
    audience:  strArr,
    struggle:  str,
    market: {
      type: "object", additionalProperties: false, required: ["type", "city"],
      properties: { type: { type: "string", enum: MARKET_TYPES }, city: str },
    },
    price_band: str,  // "" for non-business goals
    positioning: str, // one line, written as the creator would say it
    platform: {
      type: "object", additionalProperties: false, required: ["primary", "rework"],
      properties: {
        primary: { type: "string", enum: PRIMARY_PLATFORMS },
        rework:  { type: "array", items: { type: "string", enum: PLATFORMS } },
      },
    },
    stage: { type: "string", enum: STAGES },
    pillars: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["name", "role", "share", "job"],
        properties: { name: str, role: { type: "string", enum: PILLAR_ROLES }, share: { type: "integer" }, job: str },
      },
    },
    formats: strArr,
    cadence: {
      type: "object", additionalProperties: false, required: ["posts_per_week", "batch", "slot"],
      properties: {
        posts_per_week: { type: "integer" },
        batch: str,
        slot: {
          type: "object", additionalProperties: false, required: ["weekday", "time", "place"],
          properties: { weekday: str, time: str, place: str },
        },
      },
    },
    path_to_results: str,
    metrics: strArr,
    guardrails: {
      type: "object", additionalProperties: false, required: ["off_limits", "rules"],
      properties: { off_limits: strArr, rules: str },
    },
    opening_note:   str,   // the strategist's read, first person, short paragraph
    still_learning: strArr,
    first_post: {
      type: "object", additionalProperties: false, required: ["hook", "outline", "caption", "why"],
      properties: { hook: str, outline: str, caption: str, why: str },
    },
  },
};

// Sections a user can point "This isn't quite right" at. The interpreter is
// told which one the user was looking at; the profile tab maps its Edit rows
// onto the onboarding screens with `open_screen` (1..5).
export const SECTIONS = ["lane", "pillars", "where_and_how", "rhythm", "results", "first_posts", "watch", "learning", "first_post", "opening_note"];

function isStr(v)  { return typeof v === "string"; }
function isArrOfStr(v) { return Array.isArray(v) && v.every(isStr); }

// Returns an array of problems; [] means valid. Cheap, structural; the
// rubric check in output-check.js judges the prose.
export function validateStrategy(s) {
  const p = [];
  if (!s || typeof s !== "object") return ["not an object"];
  if (!s.goal || !GOALS.includes(s.goal.primary)) p.push("goal.primary");
  if (!s.goal || !Array.isArray(s.goal.secondary) || !s.goal.secondary.every(g => GOALS.includes(g))) p.push("goal.secondary");
  for (const k of ["identity", "edge", "struggle", "price_band", "positioning", "path_to_results", "opening_note"]) {
    if (!isStr(s[k])) p.push(k);
  }
  if (!isArrOfStr(s.audience) || s.audience.length === 0) p.push("audience");
  if (!s.market || !MARKET_TYPES.includes(s.market.type) || !isStr(s.market.city)) p.push("market");
  if (!s.platform || !PRIMARY_PLATFORMS.includes(s.platform.primary)) p.push("platform.primary");
  if (!s.platform || !Array.isArray(s.platform.rework) || !s.platform.rework.every(x => PLATFORMS.includes(x))) p.push("platform.rework");
  if (s.platform && s.platform.rework && s.platform.rework.includes(s.platform.primary)) p.push("platform.rework contains primary");
  if (!STAGES.includes(s.stage)) p.push("stage");
  if (!Array.isArray(s.pillars) || s.pillars.length < 2 || s.pillars.length > 5) p.push("pillars.length");
  else {
    let total = 0;
    for (const pl of s.pillars) {
      if (!pl || !isStr(pl.name) || !PILLAR_ROLES.includes(pl.role) || !Number.isInteger(pl.share) || !isStr(pl.job)) { p.push("pillars.item"); break; }
      total += pl.share;
    }
    if (total < 95 || total > 105) p.push("pillars.share total " + total);
  }
  if (!isArrOfStr(s.formats) || s.formats.length === 0) p.push("formats");
  if (!s.cadence || !Number.isInteger(s.cadence.posts_per_week) || s.cadence.posts_per_week < 1 || s.cadence.posts_per_week > 14) p.push("cadence.posts_per_week");
  if (!s.cadence || !isStr(s.cadence.batch)) p.push("cadence.batch");
  if (!s.cadence || !s.cadence.slot || !isStr(s.cadence.slot.weekday) || !isStr(s.cadence.slot.time) || !isStr(s.cadence.slot.place)) p.push("cadence.slot");
  if (!isArrOfStr(s.metrics) || s.metrics.length === 0) p.push("metrics");
  if (!s.guardrails || !isArrOfStr(s.guardrails.off_limits) || !isStr(s.guardrails.rules)) p.push("guardrails");
  if (!isArrOfStr(s.still_learning)) p.push("still_learning");
  if (!s.first_post || !["hook", "outline", "caption", "why"].every(k => isStr(s.first_post[k]) && s.first_post[k].trim())) p.push("first_post");
  return p;
}

// Normalise pillar shares to sum to 100 after a patch moved one of them.
export function normalisePillarShares(strategy) {
  if (!strategy || !Array.isArray(strategy.pillars) || !strategy.pillars.length) return strategy;
  const total = strategy.pillars.reduce((n, p) => n + (Number.isInteger(p.share) ? p.share : 0), 0);
  if (total === 100 || total <= 0) return strategy;
  let acc = 0;
  strategy.pillars.forEach((p, i) => {
    if (i === strategy.pillars.length - 1) { p.share = 100 - acc; return; }
    p.share = Math.round((p.share || 0) * 100 / total);
    acc += p.share;
  });
  return strategy;
}
