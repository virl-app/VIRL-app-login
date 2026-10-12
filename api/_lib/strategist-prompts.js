// [PR1] Prompts for the strategist: the "What I heard" extraction, the
// strategy build, the "This isn't quite right" interpreter, and the block
// that hands a stored strategy to every later generation.
//
// Register: the strategist speaks as VIRL (virl-persona.js). Everything the
// creator will publish (first_post.hook/caption, pillar names the creator
// would say) is in the creator's voice. The persona sheet and the rationale
// rules are imported, never copied.

import { VIRL_PERSONA, RATIONALE_RULES, selfCheckFor } from "./virl-persona.js";
import { STYLE_GUARD } from "./prompts.js";
import { GOALS, GOAL_LABELS, PLATFORMS, PRIMARY_PLATFORMS, PILLAR_ROLES, STAGES } from "./strategy-schema.js";

// ── Text-first platform rules (brief: PR 1) ───────────────────────────────
export const TEXT_FIRST_RULES = ""
  + "TEXT-FIRST PLATFORMS. LinkedIn, X and Threads are text-first; they get their own formats, cadence and metrics, never a video plan with the camera removed.\n"
  + "- LinkedIn: may lead when the goal is authority, clients (B2B or professional services), or launch. Formats: a text post that opens with one strong line, a document carousel as PDF, an optional short video no more than monthly. Cadence 2 to 3 posts a week regardless of time band. Comments-first growth: the plan includes 3 comments a day on others' posts as a standing item, written by the user. Metrics: comments per post, profile views, DMs or connection requests. Camera comfort does not gate a LinkedIn strategy. Hashtags: at most 3, never in the first line.\n"
  + "- X: posts under 280 characters or a short thread of 3 to 5 posts; cadence daily or near-daily within the time band; metrics replies and reposts; no hashtags.\n"
  + "- Threads: 100 to 300 characters, conversational tone, cadence 4 to 7 a week, metrics replies and reposts. Threads is the default secondary for Instagram-primary users with a text-friendly goal.\n"
  + "- Either X or Threads may be primary for authority or community goals when chosen.\n"
  + "- Pinterest is never primary. When chosen, list it under rework with one line: the weekly rendered static post becomes a pin with a keyword-led title and description.\n"
  + "- Other (free text) is rework only.\n";

export const ONE_PRIMARY_RULE = ""
  + "ONE PRIMARY PLATFORM. Every other platform the creator uses is a rework target: the primary's idea rewritten for that platform's length, tone and format. Never a copy, never a second native plan. Say \"rework\", never \"repost\". Eight platforms must not produce eight plans.\n";

export const PERSONA_SHORT = ""
  + "WRITING AS THE STRATEGIST: first person, short, specific, states the trade-off. Never \"as an AI\", never apologise, no emojis. One sentence for small notes; a short paragraph only for the opening note.\n";

function j(v) { return JSON.stringify(v); }

// ── 1. "What I heard" ─────────────────────────────────────────────────────
export const HEARD_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["identity", "items", "audience", "market", "city", "edge", "price_bands", "reflection"],
  properties: {
    identity:    { type: "string" },
    items:       { type: "array", items: { type: "string" } },   // offers or topics, 3-6
    audience:    { type: "array", items: { type: "string" } },   // 4-6
    market:      { type: "string", enum: ["local", "online", "both"] },
    city:        { type: "string" },
    edge:        { type: "string" },
    price_bands: { type: "array", items: { type: "string" } },   // business goals only; else []
    reflection:  { type: "string" },
  },
};

export function heardPrompt({ goal, about }) {
  const system = VIRL_PERSONA + "\n\n" + PERSONA_SHORT
    + "You are reading two interview answers and writing back what you heard, as editable cards. Be concrete and short. Use the creator's own words where they gave them; infer only what the text supports. "
    + "identity: one line, who they are and where (e.g. \"med spa owner in Franklin, TN\"). items: 3 to 6 chips, what they offer or talk about, each 1-4 words. audience: 4 to 6 chips, who it's for. market: local, online or both; city only if inferable, else \"\". edge: what makes them different, only if they stated it, else \"\". price_bands: for the goals clients or income, 3 to 4 price-band chips like \"$50 to $500\" or \"Under $100\"; otherwise []. reflection: one sentence back to them in your voice that shows you understood, no flattery.";
  const prompt = "GOAL they picked: " + (GOAL_LABELS[goal] || goal) + "\n\nABOUT THEM, in their words:\n" + about;
  return { system, prompt };
}

// ── 2. Strategy build ─────────────────────────────────────────────────────
// answers: { goal: {primary, secondary[]}, about, heard: {...edited cards},
//            reality: { platforms[], sizes{}, camera, time, slot{weekday,time,place} },
//            voice: { sample, tone[], off_limits, rules, emoji_use, emoji_where } }
// research: [{ finding, source_url, fetched_at }]
// extras:   { playbookLines: string, nicheModel: string, fingerprint: string, existingProfile: string }
export function buildPrompt(answers, research, extras) {
  const a = answers || {};
  const x = extras || {};
  const system = VIRL_PERSONA + "\n\n" + RATIONALE_RULES + "\n\n" + STYLE_GUARD + "\n\n"
    + TEXT_FIRST_RULES + "\n" + ONE_PRIMARY_RULE + "\n" + PERSONA_SHORT + "\n"
    + "YOUR JOB: build this creator's one-page content strategy from their interview answers, their voice sample and the research findings. Everything you return is read by later calls that write their weekly plan, so be decisive and specific to them.\n"
    + "Rules for the fields:\n"
    + "- goal: echo their picks. identity, edge, audience, struggle, market, price_band: from the interview; \"\" or [] when not stated, never invented.\n"
    + "- positioning: one line, written as the creator would say it to a stranger (creator's voice).\n"
    + "- platform.primary: ONE platform from the ones they use, chosen for the goal. rework: the rest of their platforms, each a rework target. Never Pinterest or Other as primary.\n"
    + "- stage: start | grow | convert | scale, from their platform sizes and goal.\n"
    + "- pillars: 3 or 4. Each has a role (reach, trust, connection, convert), a share (integers summing to 100) and a job: one sentence on what that pillar does for the goal. Lower convert for creators whose goal is community or who said they hate selling.\n"
    + "- formats: 3 to 5, honouring camera comfort (a creator who would rather not be on camera gets no talking-to-camera format; one format is always the weekly rendered static post: a text carousel or quote card) and the text-first rules.\n"
    + "- cadence: posts_per_week within their time per week (about 1 hour: 2 to 3; 2 to 3 hours: 3 to 4; 4 to 6: 4 to 5; 7+: 5 to 7), batch: how they make a week's content in one sitting, slot: the content slot they gave.\n"
    + "- path_to_results: the specific chain from a post to the thing they want (DM, booking, sale, follower), as a sentence.\n"
    + "- metrics: 3 numbers worth watching for THIS goal and platform, not vanity ones.\n"
    + "- guardrails: off_limits from their answers; rules: the rules they work under plus any the niche imposes (e.g. no guaranteed results for medical aesthetics), one short paragraph.\n"
    + "- opening_note: your read, first person, a short paragraph: what you heard, the call you are making and the trade-off it implies. Start with \"Here's my read.\"\n"
    + "- still_learning: 2 to 4 short things you don't know yet and will watch for.\n"
    + "- first_post: a post they can make tonight. hook, outline (3 to 6 lines, what to show or say), caption (in THEIR voice, matching the sample's rhythm, contraction level and emoji use), why (your voice, one or two sentences citing a pillar and a research finding or a stated fact).\n"
    + "- Cite research only when a finding is in the RESEARCH block. Never invent a trend, statistic or platform claim.\n"
    + "\n" + selfCheckFor({ artifact: "strategy", multi: true });

  const lines = [];
  lines.push("INTERVIEW ANSWERS");
  lines.push("goal: " + j(a.goal));
  lines.push("about them (their words): " + (a.about || ""));
  lines.push("what I heard (confirmed/edited by them): " + j(a.heard || {}));
  lines.push("their reality: " + j(a.reality || {}));
  lines.push("sound like you: " + j(Object.assign({}, a.voice || {}, { sample: undefined })));
  if (a.voice && a.voice.sample) lines.push("\nVOICE SAMPLE (their own writing or transcribed voice note; match its rhythm in first_post.caption):\n" + String(a.voice.sample).slice(0, 2500));
  if (x.fingerprint) lines.push("\n" + x.fingerprint);
  if (x.existingProfile) lines.push("\nWHAT THEIR OLDER PROFILE SAID (lower priority than the interview; use for facts the interview did not cover):\n" + x.existingProfile);
  if (x.nicheModel) lines.push("\n" + x.nicheModel);
  if (x.playbookLines) lines.push("\nPLATFORM PLAYBOOK (current mechanics, monthly research):\n" + x.playbookLines);
  lines.push("\nRESEARCH (this creator's niche, fetched now):\n" + (Array.isArray(research) && research.length
    ? research.map((r, i) => (i + 1) + ". " + r.finding + (r.source_url ? " [" + r.source_url + "]" : "")).join("\n")
    : "(no findings came back; do not cite any)"));
  lines.push("\nReturn the strategy JSON.");
  return { system, prompt: lines.join("\n") };
}

// Rebuild after a rubric failure: the same prompt plus what failed.
export function buildRetryNote(failures) {
  return "\n\nA reviewer flagged the previous draft. Fix these before anything else:\n"
    + failures.map(f => "- " + f.item + ": " + f.note).join("\n");
}

// ── 3. "This isn't quite right" ───────────────────────────────────────────
export function interpretPrompt({ strategy, section, text, notes }) {
  const system = VIRL_PERSONA + "\n\n" + PERSONA_SHORT + TEXT_FIRST_RULES + ONE_PRIMARY_RULE
    + "\nYou maintain this creator's strategy JSON. They just told you, in their own words, that a section isn't quite right. Decide what to change, express it as RFC 6902 JSON Patch operations against the strategy, and write one sentence back to them.\n"
    + "Rules:\n"
    + "- Change the smallest thing that honours what they said. Keep pillar shares summing to 100 (adjust the others when you move one).\n"
    + "- If their words are not actionable (nonsense, a question with no ask, or something the strategy can't hold), return no changes and a note that says what you kept and why, or asks which section they mean.\n"
    + "- If what they said is really an answer to an onboarding screen (their platforms, camera comfort, time, slot, voice sample, goal), set open_screen to that screen number (1 goal, 2 about you, 3 what I heard, 4 your reality, 5 sound like you) so it can be re-asked there, and still apply any change you can.\n"
    + "- note: one sentence, first person, states what changed and the trade-off, or what you kept and why.\n"
    + "- Every path must exist in the strategy below; use replace for existing values, add only for new array items.\n"
    + "Reply with JSON only: {\"changes\": [ {\"op\":\"replace\",\"path\":\"/pillars/2/share\",\"value\":20}, ... ], \"note\": \"...\", \"open_screen\": null }";
  const prompt = "STRATEGY (current):\n" + j(strategy)
    + "\n\nSECTION they were looking at: " + (section || "unknown")
    + (Array.isArray(notes) && notes.length ? "\n\nTHINGS THEY HAVE TOLD YOU BEFORE (newest last):\n" + notes.slice(-6).map(n => "- " + n).join("\n") : "")
    + "\n\nWHAT THEY SAID NOW:\n" + text;
  return { system, prompt };
}

// ── 3b. [PR3] The monthly review ─────────────────────────────────────────
// The strongest model reads this creator's own numbers and writes the
// review: a short paragraph, findings that each name their evidence, and 1
// to 3 proposals, each an RFC 6902 patch the creator can accept or keep.
export function reviewPrompt({ strategy, lines, notes, prevRates, askFresh }) {
  const system = VIRL_PERSONA + "\n\n" + PERSONA_SHORT + ONE_PRIMARY_RULE
    + "\nYou are writing this creator's monthly review from their own rows: what they planned, what they marked posted or skipped, the pillar and format they posted most, what they said popped or flopped, the results they attributed to posts, any insights screenshots, and how often they picked the caption written with their voice fingerprint.\n"
    + "Rules:\n"
    + "- Only the facts in THEIR DATA below are evidence. Never invent a number, a post, or a reason. If the data is thin, say so and propose less.\n"
    + "- opening: one short paragraph (3 to 5 sentences), first person, specific: what happened this month in their words, the one thing that mattered, what you're proposing. Cite real titles and counts (\"you posted every Trust post and skipped two of three Reach posts\"). When a tap says a post got them a booking or a client, name it (\"That first-visit walkthrough brought a booking.\").\n"
    + "- findings: 2 to 5 items. Each `text` is one sentence; each `evidence` names the rows it rests on (counts, titles, reasons) in a short phrase.\n"
    + "- proposals: 0 to 3. Only propose what the evidence supports. Each has `title` (under 10 words, e.g. \"Move Reach to 20%\"), `evidence` (the rows it rests on), `note` (one sentence: the trade-off), and `changes` (RFC 6902 ops against the STRATEGY JSON: replace existing values, add only for new array items; when you move one pillar share, adjust the others so shares still sum to 100; every path must exist). Typical proposals: pillar shares, cadence posts_per_week, formats, a guardrail rule, path_to_results wording. Never change the primary platform or the goal in a review.\n"
    + "- voice_line: one sentence on their voice. With voice checks, state the running rate as \"your captions sounded like you N of M times.\"" + (askFresh ? " It has been under 60% for two reviews: ask for three fresh captions pasted into Sound like you, and say why." : " Without checks, say there's nothing to report yet.") + "\n"
    + "- No praise padding, no \"great job\", no emojis. Short sentences. Contractions are fine.\n"
    + "Reply with JSON only: {\"opening\": \"...\", \"findings\": [{\"text\": \"...\", \"evidence\": \"...\"}], \"proposals\": [{\"title\": \"...\", \"evidence\": \"...\", \"note\": \"...\", \"changes\": [{\"op\":\"replace\",\"path\":\"/pillars/2/share\",\"value\":20}]}], \"voice_line\": \"...\"}";
  const prompt = "STRATEGY (current):\n" + j(strategy)
    + "\n\nTHEIR DATA (this account only):\n" + (lines || []).map(l => "- " + l).join("\n")
    + (Array.isArray(prevRates) && prevRates.length ? "\n\nVoice-check rate in earlier reviews: " + prevRates.map(r => Math.round(r * 100) + "%").join(", ") : "")
    + (Array.isArray(notes) && notes.length ? "\n\nTHINGS THEY HAVE TOLD YOU (newest last):\n" + notes.slice(-6).map(n => "- " + n).join("\n") : "")
    + "\n\nWrite the review.";
  return { system, prompt };
}

// [PR3] Voice check: the plan's caption carries the creator's fingerprint;
// this makes the other variant, same content in a neutral professional
// voice, so the pick tells us whether the fingerprint is doing its job.
export function voiceVariantPrompt({ caption, platform }) {
  const system = "You rewrite a social caption so it says the same things, at the same length, for the same platform, but in a neutral, polished, professional voice with none of the original writer's personal habits: standard sentence case, no trailing fragments, no slang, no signature phrases, keep or drop emojis as the original did. Return the rewritten caption only, no preface.";
  const prompt = "PLATFORM: " + (platform || "unknown") + "\n\nCAPTION:\n" + caption;
  return { system, prompt };
}

// ── 4. Hand the strategy to later generation ──────────────────────────────
// Rendered into the prompt of every generation surface once a strategy
// exists. Authoritative over the older settings line in the plan prompt.
export function formatStrategyForPrompt(strategy, notes) {
  if (!strategy || typeof strategy !== "object") return "";
  const s = strategy;
  const lines = [];
  lines.push("THE CREATOR'S STRATEGY (built with them; this is what the plan serves. Where it disagrees with any generic settings above, the strategy wins):");
  lines.push("- Goal: " + (GOAL_LABELS[s.goal && s.goal.primary] || (s.goal && s.goal.primary) || "") + (s.goal && s.goal.secondary && s.goal.secondary.length ? " (also: " + s.goal.secondary.map(g => GOAL_LABELS[g] || g).join(", ") + ")" : ""));
  if (s.identity)    lines.push("- Who they are: " + s.identity + (s.edge ? " — " + s.edge : ""));
  if (s.positioning) lines.push("- Positioning (their words): " + s.positioning);
  if (Array.isArray(s.audience) && s.audience.length) lines.push("- Audience: " + s.audience.join("; "));
  if (s.market)      lines.push("- Market: " + s.market.type + (s.market.city ? ", " + s.market.city : ""));
  if (s.platform)    lines.push("- Primary platform: " + s.platform.primary + ". Rework targets (the primary's idea rewritten for each, never copied): " + ((s.platform.rework || []).join(", ") || "none"));
  if (s.stage)       lines.push("- Stage: " + s.stage);
  if (Array.isArray(s.pillars)) lines.push("- Pillars (every post maps to one, and carries its role): " + s.pillars.map(p => p.name + " [" + p.role + ", " + p.share + "%]: " + p.job).join(" | "));
  if (Array.isArray(s.formats)) lines.push("- Formats: " + s.formats.join(", "));
  if (s.cadence)     lines.push("- Rhythm: " + s.cadence.posts_per_week + " posts a week; " + s.cadence.batch + (s.cadence.slot ? "; content slot " + [s.cadence.slot.weekday, s.cadence.slot.time, s.cadence.slot.place].filter(Boolean).join(" ") : ""));
  if (s.path_to_results) lines.push("- How content turns into results: " + s.path_to_results);
  if (Array.isArray(s.metrics)) lines.push("- What we watch: " + s.metrics.join(", "));
  if (s.guardrails)  lines.push("- Guardrails: " + ((s.guardrails.off_limits || []).length ? "off limits: " + s.guardrails.off_limits.join(", ") + ". " : "") + (s.guardrails.rules || ""));
  if (Array.isArray(notes) && notes.length) lines.push("- Things they've told the strategist since (newest last; honour them): " + notes.slice(-8).map(n => "\"" + n + "\"").join(" "));
  return lines.join("\n");
}

export const KNOWN = { GOALS, PLATFORMS, PRIMARY_PLATFORMS, PILLAR_ROLES, STAGES };
