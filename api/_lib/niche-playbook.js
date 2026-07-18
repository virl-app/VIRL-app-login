// [NICHE-PLAYBOOK] Per-niche success models + per-goal tactics, injected
// into plan and strategy prompts so "what winning looks like in this
// creator's niche" is grounded data, not the model's generic priors.
//
// Structure mirrors the platform playbook's role in the prompt stack:
//   - platform playbook = HOW each channel's algorithm rewards content
//   - niche playbook    = WHAT success looks like as a business in this
//                         vertical, and which tactics serve each goal
//
// v1 ships as a curated in-repo seed (same steady-state pattern as
// compliance.js#FLOOR_RULES — no table dependency, admin-reviewable via
// PR). If a Supabase `niche_playbook` table ships later, add a loader
// that falls through to these seeds, mirroring compliance.js.
//
// Buckets are keyed by prompts.js#nicheCategory so the two modules can
// never disagree about which bucket a creator lands in.
//
// Numbers policy: every figure below is a conservative, cross-platform
// rule of thumb, and the rendered block explicitly labels them as
// directional baselines. Their job is to stop the model from inventing
// fresh thresholds each week — not to promise outcomes.

import { nicheCategory } from "./prompts.js";

// ── Per-bucket success models ──────────────────────────────────────────────
// success_model: how content actually converts to business results in
//   this vertical (the "physics" of the niche).
// funnel: target mix across attract / nurture / convert posts, with what
//   each stage means HERE — generic funnel advice is exactly the
//   assumption-slop this module exists to replace.
// kpis: the numbers that actually predict business results in this niche
//   (so success metrics stop defaulting to vanity reach).
const NICHE_MODELS = {
  real_estate: {
    label: "Real Estate",
    success_model:
      "People hire the agent they feel they already know. Content converts through local authority (market data, neighborhood knowledge) plus personal familiarity (life as an agent, client stories) — not through broadcasting listings. Listings are proof of activity, not the growth engine.",
    funnel:
      "Attract ~40% (neighborhood spotlights, market myths, local lifestyle hooks that travel beyond followers), Nurture ~40% (process education, client stories, day-in-the-life, personality), Convert ~20% (listings, open houses, direct 'thinking of selling?' CTAs).",
    kpis: [
      "DMs and profile visits (the real pipeline signal)",
      "saves on market-data and neighborhood posts",
      "local-audience share and repeat commenters",
      "listing/buyer consult requests started from social",
    ],
  },
  service_business: {
    label: "Service Business",
    success_model:
      "Local visibility plus visible proof wins. Prospects need to see the work (before/after, process), the people (team, owner), and other customers vouching — then a low-friction way to inquire. Consistency beats cleverness in local service verticals.",
    funnel:
      "Attract ~40% (before/after transformations, surprising process moments, local hooks), Nurture ~35% (team/behind-the-scenes, FAQ posts, customer stories), Convert ~25% (offers, booking CTAs, seasonal pushes).",
    kpis: [
      "inquiries/bookings started from social (DM, call, form)",
      "shares of before/after and proof posts",
      "profile visits and website taps",
      "reviews/testimonials generated or featured",
    ],
  },
  coach_consultant: {
    label: "Coach / Consultant",
    success_model:
      "Authority converts through depth, not volume. The audience buys after repeated proof of expertise (frameworks, client outcomes, contrarian-but-defensible takes) and a trust path off-platform (email list, lead magnet, discovery call). Saves and shares predict revenue better than likes.",
    funnel:
      "Attract ~35% (sharp frameworks, myth-busts, hot takes with receipts), Nurture ~40% (client results, teaching threads/carousels, personal narrative that builds trust), Convert ~25% (lead magnet, discovery-call CTA, offer breakdowns, objection-handling).",
    kpis: [
      "saves and shares on teaching content",
      "email-list signups / lead-magnet requests",
      "discovery calls or qualified DMs started",
      "profile visits from long-form posts",
    ],
  },
  fitness_pro: {
    label: "Fitness Professional",
    success_model:
      "Demonstration plus transformation proof sells coaching. The audience needs to see competence (form fixes, workout demos), results (client transformations), and personality (training life) before they buy programs or coaching. Watch time on demos is the leading indicator.",
    funnel:
      "Attract ~45% (workout demos, form fixes, relatable gym moments), Nurture ~35% (client transformations, training philosophy, personal journey), Convert ~20% (program/coaching CTAs, testimonials with a direct ask, limited-spots pushes).",
    kpis: [
      "watch time / completion on demo videos",
      "saves on workout breakdowns",
      "coaching or program inquiries via DM",
      "shares of transformation posts",
    ],
  },
  wellness: {
    label: "Wellness",
    success_model:
      "Education plus relatability builds a trusted-voice position; conversion is soft and consent-based (guides, newsletters, programs). Saves are the currency — content that people file away for later ('recipes, routines, how-tos') compounds into authority.",
    funnel:
      "Attract ~35% (myth-busts, surprising education, relatable struggles), Nurture ~40% (routines, recipes, frameworks, personal practice), Convert ~25% (guide/newsletter CTAs, program mentions, gentle offer posts).",
    kpis: [
      "saves on educational and recipe/routine posts",
      "newsletter/guide signups",
      "comments sharing personal experience (trust signal)",
      "DMs asking for specifics",
    ],
  },
  healthcare_provider: {
    label: "Healthcare Provider",
    success_model:
      "Credibility-first education wins. Patients choose providers who explain clearly and demystify care; content converts through educational authority plus approachability, never through pressure. Every conversion CTA is an invitation to ask questions or book — soft, compliant, zero hype.",
    funnel:
      "Attract ~40% (condition explainers, myth-busts, 'what your symptom actually means'), Nurture ~40% (behind-the-practice, team, patient-experience walk-throughs, FAQ), Convert ~20% (appointment-request CTAs framed as education: 'if this sounds familiar, we can help').",
    kpis: [
      "appointment requests / contact starts from social",
      "saves on explainer content",
      "profile visits and website taps",
      "questions asked in comments/DMs",
    ],
  },
  retail_product: {
    label: "Retail / Product",
    success_model:
      "Product-in-context plus social proof drives purchases. The audience buys after seeing the product used by real people in real settings (styling, demos, UGC-style content) with low-friction paths to shop. Aesthetic consistency builds brand; proof posts close.",
    funnel:
      "Attract ~40% (styling/usage ideas, trend participation with the product in frame, aesthetic content), Nurture ~35% (behind-the-brand, customer features, how-it's-made), Convert ~25% (launches, restocks, offers, direct shop CTAs).",
    kpis: [
      "link clicks / shop taps",
      "'price?' / 'link?' DMs and comments",
      "saves on styling and usage posts",
      "UGC or customer-feature submissions",
    ],
  },
  creator: {
    label: "Creator",
    success_model:
      "Consistency plus a recognizable format franchise grows audience; monetization follows attention. The win condition is a repeatable series people come back for, a distinct voice, and format-native craft (hooks, watch time). Growth first, then layer monetization goals on top.",
    funnel:
      "Attract ~45% (hook-driven format-native content, trend participation, series episodes), Nurture ~35% (personality, behind-the-scenes, community replies), Convert ~20% (whatever the creator's monetization path is — deals, products, memberships).",
    kpis: [
      "follows per post and reach beyond followers",
      "watch time / completion rate",
      "repeat commenters (community depth)",
      "saves and shares on series content",
    ],
  },
};

// ── Follower-tier baselines ────────────────────────────────────────────────
// Directional, cross-platform baselines so success metrics scale to the
// creator's actual size instead of the model inventing thresholds. The
// rendered line tells the model these are starting baselines that LOGGED
// RESULTS always override.
function followerTier(followers) {
  const f = String(followers || "").toLowerCase();
  if (f.indexOf("100k") >= 0) return "large";
  if (f.indexOf("20k") >= 0)  return "mid";
  if (f.indexOf("5k") >= 0)   return "established";
  if (f.indexOf("1k-") >= 0 || f === "1k-5k") return "early";
  return "nano";
}

const TIER_BASELINES = {
  nano:
    "Under 1K followers: a strong week is showing up, not blowing up — every post shipped on schedule, a handful of saves/comments per post, 1-3 real conversations (DMs/replies) started, +10-40 net followers. Short-form reach can spike past follower count; treat spikes as bonuses, not baselines.",
  early:
    "1K-5K followers: a strong week is 2-4 posts clearing your recent average views, 10-30 saves across the week, 3-5 real conversations started, +30-100 net followers. Consistency and conversation quality matter more than any single post's reach.",
  established:
    "5K-20K followers: a strong week is 1-2 posts reaching well beyond your follower count, 40+ saves across the week, measurable business signal (inquiries, link clicks, list signups), +100-300 net followers.",
  mid:
    "20K-100K followers: a strong week is engagement rate holding as reach grows, meaningful business conversion (leads, bookings, sales attributable to social), and at least one post that travels — shares being the signal to watch.",
  large:
    "100K+ followers: a strong week is conversion depth over reach — business outcomes per post, community health (repeat commenters), and protecting engagement rate while scaling content volume.",
};

// ── Per-goal tactics ───────────────────────────────────────────────────────
// Keyed by the exact GOALS labels the client offers. Each entry gives the
// model a concrete tactical spine for the goal so 'aligned with my goal'
// stops meaning 'the model's best guess at what the goal implies.'
const GOAL_TACTICS = {
  "Grow my following": {
    focus: "Reach-first: content built to travel beyond current followers and convert viewers to follows.",
    moves: "Lead with searchable/shareable topics over personal updates; participate early in relevant trends; make the first 2 seconds earn the stop; end strong posts with a reason to follow ('I post X every week').",
    metric: "follows per post, reach beyond followers, shares",
  },
  "Land brand deals": {
    focus: "Prove you can sell: niche clarity, strong engagement rate, and content that shows products/experiences integrated naturally.",
    moves: "Keep a tight, legible niche; create 1-2 posts/week that demonstrate seamless product integration (organic mentions, favorites round-ups); showcase storytelling range; keep engagement rate healthy — brands read it before follower count.",
    metric: "engagement rate, saves, story replies",
  },
  "Sell products": {
    focus: "Product-in-use over product-on-shelf, with social proof and a soft-sell cadence (~80% value / 20% direct ask).",
    moves: "Show the product solving a real moment; feature customers and reviews; handle the top purchase objection in content; run launch/restock arcs with honest urgency; make the buying path frictionless in every CTA.",
    metric: "link clicks, 'price?/link?' DMs, add-to-carts if tracked",
  },
  "Sell my services": {
    focus: "Authority plus proof: the audience must see competence, results, and what working with you is like — then get one clear ask per week.",
    moves: "Client results and process education weekly; answer the questions prospects actually ask; one direct offer post per week max, carried by proof not pressure.",
    metric: "qualified DMs, consult/inquiry starts",
  },
  "Book appointments / consults": {
    focus: "Remove friction and fear: show exactly what happens when they book, then make the ask specific and easy.",
    moves: "Walk through the first appointment/call step by step; feature real client/patient experiences; one clear booking CTA with a single link — repeated consistently, not rotated.",
    metric: "bookings started from social, DM inquiries",
  },
  "Generate leads": {
    focus: "Trade genuine value for contact info: lead magnet content loops that convert attention to a list you own.",
    moves: "Build posts that naturally gate depth ('comment GUIDE and I'll send it'); teach enough to prove the paid/gated thing is worth it; drive email signups — the list is the asset, the algorithm is rented.",
    metric: "keyword comments, magnet requests, email signups",
  },
  "Convert followers to clients": {
    focus: "Nurture-heavy: the audience already knows you — content's job is resolving objections and starting conversations.",
    moves: "Objection-handling posts (price, timing, 'will this work for me'); client stories matched to follower personas; DM-conversation starters ('which of these is you?'); direct invitations that assume familiarity.",
    metric: "DM conversations started, replies to CTAs",
  },
  "Drive traffic to my site or listings": {
    focus: "Curiosity with a destination: every traffic post opens a loop the link closes.",
    moves: "Tease the payoff, deliver it at the destination ('full tour / full list / full guide at the link'); use each platform's native link mechanics (bio link, stories link sticker, Pinterest outbound); make link CTAs specific ('see all 14 photos'), never generic ('check it out').",
    metric: "link clicks, profile visits, site sessions from social",
  },
  "Build community": {
    focus: "Conversation over broadcast: content engineered to be answered, not just consumed.",
    moves: "Ask real questions you actually want answers to; feature and reply to audience contributions; run recurring named series people can anticipate; show up in comments within the first hour.",
    metric: "comments per post, repeat commenters, replies sent",
  },
  "Go viral": {
    focus: "High-tension hooks on broadly relatable topics, shipped fast on trends — with a capture mechanism so a spike converts.",
    moves: "Choose topics with built-in tension or strong relatability; jump on format trends within days, not weeks; make content remixable/shareable; always pair reach plays with a follow reason — virality without capture evaporates. Be honest: viral is variance; volume and hook craft raise the odds, nothing guarantees it.",
    metric: "shares, reach beyond followers, follows per 1K views",
  },
};

// ── Renderer ───────────────────────────────────────────────────────────────
// Returns a prompt-ready block, or "" when there's nothing to say (no
// niche and no goal). `compact` drops the funnel + KPI detail for the
// strategy-regen surface where the full block would dominate the prompt.
export function formatNichePlaybookForPrompt(niche, goal, goalSecondary, followers, opts) {
  const compact = !!(opts && opts.compact);
  const model = NICHE_MODELS[nicheCategory(niche)] || NICHE_MODELS.creator;
  const lines = [];

  lines.push("NICHE SUCCESS PLAYBOOK (" + (model.label) + ") — ground the strategy and every card's intent in this, not in generic social-media advice:");
  lines.push("How success actually works in this niche: " + model.success_model);
  if (!compact) {
    lines.push("Target content funnel for the week: " + model.funnel + " Balance the plan roughly to this mix — a week of all-attract or all-convert posts is a strategy failure.");
    lines.push("The numbers that predict business results in this niche (prefer these in success metrics over raw reach): " + model.kpis.join("; ") + ".");
  }

  const baseline = TIER_BASELINES[followerTier(followers)];
  if (baseline) {
    lines.push("FOLLOWER-TIER BASELINE (directional starting point ONLY — the creator's own logged results, when present above, always override these): " + baseline);
  }

  const primary = goal && GOAL_TACTICS[goal];
  if (primary) {
    lines.push("PRIMARY GOAL — " + goal + ". " + primary.focus + " Tactics: " + primary.moves + " Watch: " + primary.metric + ".");
  }
  const secondary = goalSecondary && goalSecondary !== goal && GOAL_TACTICS[goalSecondary];
  if (secondary) {
    lines.push("SECONDARY GOAL — " + goalSecondary + ". " + secondary.focus + " Tactics: " + secondary.moves + " Watch: " + secondary.metric + ".");
    lines.push("GOAL HIERARCHY — the strategy (thesis, the bet, success metrics) and the majority of cards serve the PRIMARY goal. Give the secondary goal 2-3 supporting cards that genuinely serve it. Never blend both goals' CTAs into one post — a post asks for ONE thing.");
  }

  if (!lines.length) return "";
  return "\n\n" + lines.join("\n");
}
