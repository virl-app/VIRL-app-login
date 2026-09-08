// [TREND-CLAIM-ENFORCE] Post-generation scrub for lifecycle claims the data
// cannot support.
//
// Research-fed trends (`trends` rows, served by the fallback in
// trend-context.js) carry NO lifecycle signal: they say what is being talked
// about, never what is rising or peaking. The prompt tells the model so in as
// many words, and check-strategist asserts that the prompt text says it. Until
// now nothing checked the OUTPUT — the rule held on the model's goodwill, which
// is the exact gap the product review keeps finding one link further down
// than the prompt: "the prompt says X" is not "X reached the creator".
//
// So: when the generation was research-fed, any lifecycle claim sitting next
// to a served trend's name is rewritten to the neutral wording the prompt asked
// for, and flagged. Two boundaries keep this narrow enough to be safe:
//
//   1. Only research-fed generations. An observed row has a measured status and
//      "peaking" is a true sentence about it. isResearchFed() is decided from
//      the snapshot the server itself built, not from the text.
//
//   2. Only claims within CLAIM_WINDOW characters of a served trend's name.
//      "Your engagement is exploding" is voice, not a trend claim, and this
//      must not touch it. A claim about a trend the prompt supplied is a
//      claim about the world that the data does not license.
//
// The replacement is a claim about the world, not a voice marker, so rewriting
// it does not alter the creator's register — "this sound is peaking" and "this
// sound is being talked about" are the same sentence at a different level of
// certainty. That is the line: fix the certainty, leave the sentence.
//
// Same in-place walk-and-mutate contract as scrubCompliance, so the two hook
// sites in chat.js can run it the same way.

const CLAIM_RE = /\b(?:is|are|was|were|'s|'re|currently|now|still)?\s*(peaking|blowing up|blow(?:s|ing) up|going viral|gone viral|exploding|skyrocketing|surging|taking off)\b/gi;
const NEUTRAL  = "being talked about";
const CLAIM_WINDOW = 120;
const MIN_NAME_LEN = 4;

/** True when the snapshot's served items all lack a lifecycle status — the research-fed shape. */
export function isResearchFed(snapshot) {
  const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
  if (!items.length) return false;
  return items.every(it => !it || it.status == null);
}

function servedNames(snapshot) {
  const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
  return items
    .map(it => (it && typeof it.display_name === "string") ? it.display_name.trim().toLowerCase() : "")
    .filter(n => n.length >= MIN_NAME_LEN);
}

function nameSpans(lower, names) {
  const spans = [];
  for (const n of names) {
    let i = lower.indexOf(n);
    while (i >= 0) { spans.push([i, i + n.length, n]); i = lower.indexOf(n, i + n.length); }
  }
  return spans;
}

function scrubString(s, names, path, flags) {
  if (typeof s !== "string" || !s) return s;
  const lower = s.toLowerCase();
  const spans = nameSpans(lower, names);
  if (!spans.length) return s;
  let out = "";
  let last = 0;
  CLAIM_RE.lastIndex = 0;
  let m;
  while ((m = CLAIM_RE.exec(s)) !== null) {
    const start = m.index + m[0].indexOf(m[1]);
    const end = start + m[1].length;
    const near = spans.find(([a, b]) => start >= a - CLAIM_WINDOW && end <= b + CLAIM_WINDOW);
    if (!near) continue;
    out += s.slice(last, start) + NEUTRAL;
    last = end;
    flags.push({ path, trend: near[2], original: m[1], replacement: NEUTRAL, rewritten: true });
  }
  if (!last) return s;
  return out + s.slice(last);
}

function walk(node, names, path, flags) {
  if (typeof node === "string") return scrubString(node, names, path, flags);
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = walk(node[i], names, `${path}${path ? "." : ""}${i}`, flags);
    return node;
  }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) node[k] = walk(node[k], names, `${path}${path ? "." : ""}${k}`, flags);
    return node;
  }
  return node;
}

/**
 * Rewrite lifecycle claims adjacent to served trend names when the generation
 * was research-fed. Mutates `parsed` in place and returns it, with a flag per
 * rewrite. A generation fed by observed rows, or with no snapshot, is returned
 * untouched with no flags.
 */
export function scrubLifecycleClaims(parsed, snapshot) {
  if (!parsed || typeof parsed !== "object") return { scrubbed: parsed, flags: [] };
  if (!isResearchFed(snapshot)) return { scrubbed: parsed, flags: [] };
  const names = servedNames(snapshot);
  if (!names.length) return { scrubbed: parsed, flags: [] };
  const flags = [];
  walk(parsed, names, "", flags);
  return { scrubbed: parsed, flags };
}
