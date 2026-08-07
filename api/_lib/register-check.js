// /api/_lib/register-check.js
// ─────────────────────────────────────────────────────────────────────────────
// [REGISTER-CHECK] Detect VIRL's strategist voice leaking into copy the
// creator publishes.
//
// The two-register rule — VIRL talks TO the creator, the creator's copy is
// theirs alone — is stated in every mixed-register prompt and, until now, was
// verified nowhere. A caption reading "my call is Instagram" or "this post's
// job is reach" is VIRL talking in the creator's feed. It is the single most
// obvious tell that a human didn't write the post, and it shipped unobserved.
//
// Deliberately DETECTION-ONLY in v1, and worth being explicit about why,
// because "measured is not enforced" is a fair criticism of exactly this
// shape. compliance.js can scrub because its fix is a substitution: a banned
// phrase has a known safe replacement. Register bleed has no such fix — the
// repair is a rewrite, and a regex that rewrites a creator's caption is more
// dangerous than the bug it's fixing. So this reports, and the escalation
// path is the post-stream repair channel that already carries the compliance
// payload, once telemetry shows the real rate and confirms the patterns don't
// fire on genuine creator copy.
//
// Precision is the whole game here. A creator writing "I'd never wear this
// again" is perfectly good copy — first person is THEIRS. Only phrasings that
// are unmistakably a strategist addressing the creator about their own content
// qualify below. When in doubt, leave it out: a false positive teaches the
// team to ignore the signal, which costs more than the miss.
// ─────────────────────────────────────────────────────────────────────────────

import { CREATOR_VOICE_FIELDS, VIRL_VOICE_CONTAINERS } from "./virl-persona.js";

// Phrasings that only make sense as VIRL briefing the creator. Each is
// anchored tightly enough that ordinary creator copy shouldn't trip it.
const BLEED_PATTERNS = [
  { name: "my-call",        re: /\bmy call (?:is|here is|:)/i },
  { name: "id-lead-with",   re: /\bI'?d lead with\b/i },
  { name: "id-post-this",   re: /\bI'?d (?:post|skip|reshoot|sit on|pull) (?:this|that) one\b/i },
  { name: "post-job",       re: /\bthis (?:post|card)'?s job\b/i },
  { name: "slot-rationale", re: /\b(?:earns its slot|this slot's here)\b/i },
  { name: "algo-rationale", re: /\bthe algorithm (?:rewards|favou?rs|is favou?ring)\b/i },
  { name: "your-audience",  re: /\byour audience (?:already|shows up|responds)\b/i },
  { name: "not-get-cute",   re: /\bI'?m not going to get cute\b/i },
  { name: "optimising-for", re: /\bwe'?re optimi[sz]ing for\b/i },
  { name: "post-instruction", re: /\bpost (?:this|it) (?:on|to) (?:TikTok|Instagram|LinkedIn|Facebook|YouTube|Pinterest)\b/i },
];

// Walk a parsed generation payload and collect every string sitting at a
// creator-voice field, with the path that got us there. Skips VIRL-voice
// containers wholesale — `restDayTips[].body` is VIRL's register even though
// `body` is a creator field name elsewhere.
export function collectCreatorFields(node, path, out) {
  const acc = out || [];
  const at  = path || "";
  if (node == null) return acc;

  if (Array.isArray(node)) {
    node.forEach(function (v, i) { collectCreatorFields(v, at + "[" + i + "]", acc); });
    return acc;
  }
  if (typeof node !== "object") return acc;

  for (const [key, value] of Object.entries(node)) {
    if (VIRL_VOICE_CONTAINERS.has(key)) continue;
    const childPath = at ? at + "." + key : key;
    if (typeof value === "string") {
      if (CREATOR_VOICE_FIELDS.has(key) && value.trim()) {
        acc.push({ path: childPath, text: value });
      }
    } else if (value && typeof value === "object") {
      // An array of plain strings under a creator field (onScreenText,
      // slides as string[]) carries the creator's words too.
      if (Array.isArray(value) && CREATOR_VOICE_FIELDS.has(key)) {
        value.forEach(function (v, i) {
          if (typeof v === "string" && v.trim()) {
            acc.push({ path: childPath + "[" + i + "]", text: v });
          } else {
            collectCreatorFields(v, childPath + "[" + i + "]", acc);
          }
        });
      } else {
        collectCreatorFields(value, childPath, acc);
      }
    }
  }
  return acc;
}

// Public entry. Returns { flags: [{ path, pattern, excerpt }] } — empty when
// the output is clean. Never throws: a detector that can break a generation
// is worse than the bug it watches for.
export function detectRegisterBleed(parsed) {
  const flags = [];
  try {
    for (const field of collectCreatorFields(parsed)) {
      for (const p of BLEED_PATTERNS) {
        const m = p.re.exec(field.text);
        if (!m) continue;
        flags.push({
          path:    field.path,
          pattern: p.name,
          excerpt: field.text.slice(Math.max(0, m.index - 20), m.index + 60),
        });
        break; // one flag per field is enough to act on
      }
    }
  } catch (e) { /* detection must never break a generation */ }
  return { flags };
}
