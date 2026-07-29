// [RESEARCH-VERIFY] The fact-check + de-slop pass that every channel
// research brief now goes through before it reaches the creator's profile
// or any prompt.
//
// Why this exists. The brief in creator_handle_research is written by a
// search-grounded model (Perplexity) that has no access to the creator's
// own stated facts at write time. When a creator's accounts are thin in
// the search index, that model does what search-grounded models do: it
// resolves to the nearest plausible entity and describes THAT — a
// different company, a different domain, invented program names — in the
// same confident register it uses for things it actually read. The first
// real report of this was a creator whose brief named a business and
// website that were not hers, alongside invented product names hedged
// with "if those labels appear in the product descriptions."
//
// That failure mode has three separable defects, and this module treats
// them separately:
//
//   1. FALSE IDENTITY — a claim that contradicts creator-stated ground
//      truth (their own website domain, their own handles). Never
//      repairable by guessing a replacement; the only correct move is to
//      delete the claim and say so.
//   2. SPECULATION — a claim the writer hedged into unfalsifiability
//      ("if those labels appear", "or a similarly specific tagline").
//      A hedged observation is not an observation.
//   3. SLOP — padding, marketing adjectives, restatement, and sentences
//      that would be equally true of any creator in the niche. Harmless
//      individually, but they are what make the brief read as sloppy and
//      they dilute the real signal in every prompt that consumes it.
//
// Design contract:
//   * NEVER invent a correction. A wrong business name is removed, not
//     replaced with a guess at the right one.
//   * Deterministic guards run with or without the model. The
//     foreign-domain guard is the hard backstop for defect #1 — even a
//     verification model that misses a false brand cannot let a sentence
//     naming an unrelated domain reach the creator.
//   * Fail-open, but never fail-silent: if the model pass is
//     unavailable, the deterministic passes still run and the returned
//     verification object records that the brief was only partly
//     checked, so the UI can say so honestly instead of showing a
//     "verified" badge it hasn't earned.

import { callClaude, extractJsonObject } from "./anthropic.js";
import { MODEL_SONNET } from "./prompts.js";

// Verification is cheap relative to the research call it audits, and it
// runs at most once per research refresh (which is itself cached for 30
// days), so it runs on the same model the rest of the fleet uses rather
// than a weaker one. Getting identity claims wrong is the exact failure
// we are fixing — this is not the place to economize.
const VERIFY_MODEL      = MODEL_SONNET;
const VERIFY_MAX_TOKENS = 1600;
// The brief is at most ~12 sentences by construction; the ground-truth
// block adds the website text. Anything past this is a runaway response
// we don't want to pay to verify.
const MAX_INPUT_CHARS   = 12000;

// Domains that legitimately appear in a brief about someone's social
// presence. Anything else that looks like a domain is either the
// creator's own site (allow-listed per-call from their profile) or a
// business the research pulled in from somewhere it shouldn't have.
const PLATFORM_DOMAINS = new Set([
  "tiktok.com", "instagram.com", "youtube.com", "youtu.be", "linkedin.com",
  "facebook.com", "fb.com", "x.com", "twitter.com", "pinterest.com",
  "threads.net", "threads.com", "snapchat.com", "reddit.com", "substack.com",
  "twitch.tv", "spotify.com", "apple.com", "google.com", "zillow.com",
  "realtor.com", "linktr.ee", "beacons.ai", "canva.com",
]);

// Matches domain-ish tokens ("gogirl.ai", "www.example.com/path"). Kept
// deliberately broad on the TLD side: the guard's job is to catch a brand
// that shouldn't be there at all, and an over-broad match only ever costs
// us a sentence that mentioned some other company's website — which is
// not content a brief about THIS creator needs.
const DOMAIN_RE = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\b/gi;

// Hedges that turn an observation into a guess. Presence of one of these
// in a sentence is not automatically fatal (the model pass judges the
// sentence in context), but it is what the model is told to hunt for, and
// the worst offenders below are removed deterministically.
const HARD_HEDGE_RE = /\b(if (?:those|these|such|any of these) (?:labels?|names?|terms?|phrases?) (?:appear|are used|exist)|or (?:a )?similarly[- ]\w+|presumably|it is likely that|one would expect|appears? to be (?:some|a) (?:kind|sort) of)\b/i;

// ── Deterministic passes ───────────────────────────────────────────────────

// Strips the formatting artifacts that leak through a "no markdown"
// instruction. The Profile panel renders this text as plain text, so a
// literal "**GoGirl.ai**" shows up as asterisks on screen — which is
// half of why the brief read as sloppy even where it was accurate.
export function scrubFormatting(raw) {
  return String(raw || "")
    // Citation markers from search-grounded models: "...outdoors[1][3]."
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, "")
    // Bold / italic / inline code.
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    // Leading heading / bullet glyphs on any line.
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    // Collapse the whitespace the above leaves behind.
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

// Every domain the creator has told us is theirs, plus the bare brand
// token from it ("govirl.ai" → "govirl"). The brand token matters because
// a false-identity claim usually names the brand in prose without the
// TLD, and the sentence-level guard needs to know that "GoVirl" is
// legitimate while "GoGirl" is not.
export function ownDomainAllowlist(businessWebsite, handles) {
  const allowed = new Set();
  const brands  = new Set();

  const addUrl = (raw) => {
    const s = String(raw || "").trim();
    if (!s) return;
    let host = "";
    try {
      host = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s).hostname.toLowerCase();
    } catch (e) { return; }
    host = host.replace(/^www\./, "");
    if (!host || host.indexOf(".") < 0) return;
    allowed.add(host);
    // Subdomains and the apex are the same business: app.govirl.ai and
    // govirl.ai must both pass.
    const parts = host.split(".");
    if (parts.length > 2) allowed.add(parts.slice(-2).join("."));
    brands.add(parts[parts.length - 2] || "");
  };

  addUrl(businessWebsite);
  const safeHandles = (handles && typeof handles === "object") ? handles : {};
  Object.keys(safeHandles).forEach((k) => {
    const v = String(safeHandles[k] || "").trim();
    if (/^https?:\/\//i.test(v)) addUrl(v);
  });

  brands.delete("");
  return { domains: allowed, brands };
}

// The removal reasons are shown to the creator verbatim, so a dropped
// sentence gets quoted back on a word boundary rather than sliced
// mid-word. A creator scanning "why did it cut that?" should be able to
// recognize the sentence it cut.
function snippet(text, max) {
  const s = String(text || "").trim().replace(/\s+/g, " ");
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:]$/, "") + "...";
}

// Splits into sentences well enough for a guard. Not a linguistics
// problem — an over-eager split only ever means we drop a slightly
// smaller span of text around a false claim.
function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+(?=[A-Z"“(])/)
    .map(s => s.trim())
    .filter(Boolean);
}

// THE HARD BACKSTOP for defect #1. Drops any sentence that names a domain
// which is neither a known platform nor one the creator gave us. This
// runs after the model pass, so it catches false identities the model
// rationalized into keeping. A brief gutted by this guard is the correct
// outcome: a short honest brief beats a fluent one about the wrong company.
export function dropForeignBrandSentences(text, allowlist) {
  const kept    = [];
  const removed = [];
  const seenBad = new Set();

  splitSentences(text).forEach((sentence) => {
    const hits = [];
    let m;
    DOMAIN_RE.lastIndex = 0;
    while ((m = DOMAIN_RE.exec(sentence)) !== null) {
      const host = m[1].toLowerCase().replace(/^www\./, "");
      const apex = host.split(".").slice(-2).join(".");
      if (allowlist.domains.has(host) || allowlist.domains.has(apex)) continue;
      if (PLATFORM_DOMAINS.has(host) || PLATFORM_DOMAINS.has(apex)) continue;
      // A brand token the creator owns, written with a TLD we haven't
      // seen ("govirl.com" when they gave us govirl.ai) is a near-miss,
      // not a foreign business — let it through rather than shredding a
      // correct sentence over a typo'd TLD.
      if (allowlist.brands.has(host.split(".")[0])) continue;
      hits.push(host);
    }
    if (hits.length) {
      hits.forEach(h => seenBad.add(h));
      removed.push(sentence);
      return;
    }
    kept.push(sentence);
  });

  return { text: kept.join(" ").trim(), removed, domains: Array.from(seenBad) };
}

// Removes the sentences whose hedging is severe enough that no reader
// could act on them. Deliberately narrow — ordinary epistemic caution
// ("her audience appears to respond to...") is honest and stays.
function dropHardHedges(text) {
  const kept    = [];
  const removed = [];
  splitSentences(text).forEach((sentence) => {
    if (HARD_HEDGE_RE.test(sentence)) removed.push(sentence);
    else kept.push(sentence);
  });
  return { text: kept.join(" ").trim(), removed };
}

// ── Model pass ─────────────────────────────────────────────────────────────

const VERIFY_SYSTEM = [
  "You are a fact-checking editor. You audit an automatically generated research brief about one creator before it is shown to that creator and before it is used to write content in their voice.",
  "",
  "You have exactly two powers: keep a claim, or delete it. You may tighten wording while keeping meaning. You may NEVER add a claim, and you may NEVER repair a wrong claim by substituting what you think the right answer is — a deleted claim is a correct outcome, an invented correction is a serious error.",
  "",
  "The brief was written by a search-grounded model with no access to the creator's own stated facts. Its characteristic failure is describing a DIFFERENT person or business that happened to rank in search — confidently, in the same register it uses for things it actually read.",
].join("\n");

function buildVerifyPrompt(researchText, groundTruth) {
  const gt = groundTruth || {};
  const lines = [];

  lines.push("GROUND TRUTH — stated by the creator, authoritative, overrides anything in the brief:");
  if (gt.name)            lines.push("- First name: " + gt.name);
  if (gt.businessWebsite) lines.push("- Their business website: " + gt.businessWebsite + "  (this domain IS their business — any other company name or domain in the brief is a different entity and is wrong)");
  if (gt.handleList)      lines.push("- Their accounts:\n" + gt.handleList);
  if (gt.nicheDetail)     lines.push("- What they do, their words: " + gt.nicheDetail);
  if (gt.offerings)       lines.push("- What they sell, their words: " + gt.offerings);
  if (gt.corrections)     lines.push("- Corrections they already made to earlier research (highest authority of all): " + gt.corrections);
  if (!gt.businessWebsite && !gt.handleList) lines.push("- (little ground truth on file — be correspondingly strict about any specific named entity in the brief)");

  if (gt.siteText) {
    lines.push("");
    lines.push("ACTUAL TEXT OF THEIR WEBSITE, fetched directly (ground truth for offerings and brand terminology — if the brief describes offerings that are not in this text, the brief invented them):");
    lines.push('"""');
    lines.push(String(gt.siteText).slice(0, 3000));
    lines.push('"""');
  }

  lines.push("");
  lines.push("UNVERIFIED BRIEF:");
  lines.push('"""');
  lines.push(String(researchText).slice(0, MAX_INPUT_CHARS));
  lines.push('"""');
  lines.push("");
  lines.push("Delete a claim if ANY of these is true:");
  lines.push("1. IDENTITY CONFLICT — it names a business, brand, product, program, or website that conflicts with the ground truth above. Delete the whole claim. Do not swap in the correct name; you are not here to rewrite it into being right.");
  lines.push("2. SPECULATION — it is hedged into unfalsifiability (\"if those labels appear\", \"or a similarly specific tagline\", \"presumably\", \"one would expect\"), or it names something specific and then disclaims knowing whether it exists. A hedged observation is not an observation. If a flatly-stated, supported fragment survives inside the sentence, keep only that fragment.");
  lines.push("3. UNSUPPORTED SPECIFICS — named programs, taglines, series names, or metrics that nothing in the ground truth or the brief's own observations supports.");
  lines.push("4. SLOP — padding, marketing adjectives, praise, restatement of a point already made, or a sentence that would be equally true of any creator in this field and carries no specific detail about this one.");
  lines.push("");
  lines.push("Keep everything else, including honest uncertainty about coverage (\"her Facebook page returned no indexable posts\") — that is useful and must survive.");
  lines.push("");
  lines.push("Then rewrite what survives as plain prose a strategist can act on: no markdown, no asterisks, no bullets, no citation markers, no headings. Short and true beats long and padded. If almost nothing survives verification, return the little that does — an empty result is an acceptable and honest answer.");
  lines.push("");
  lines.push("Reply with ONLY this JSON object and nothing else:");
  lines.push('{"verified_text": "the surviving brief as plain prose, or \\"\\" if nothing survives", "removed": ["one short phrase per deleted claim, naming what was deleted and which rule caught it"], "identity_conflict": true|false}');

  return lines.join("\n");
}

// ── Public entry ───────────────────────────────────────────────────────────

// Runs the full verification chain over a raw research brief.
//
// Returns { text, excerpts, verification } — always. `text` may be ""
// when nothing survived, which callers must treat as "no usable
// research" rather than as an error.
//
// verification: {
//   checked:          true when the model pass ran (false = deterministic only)
//   removedCount:     how many claims were dropped, all passes combined
//   removed:          short human-readable reasons, for the Profile panel
//   identityConflict: true when a claim contradicted creator-stated identity
//   foreignDomains:   domains the hard guard caught, for logging + display
//   verifiedAt:       ISO timestamp
// }
export async function verifyResearch({ researchText, excerpts, groundTruth }) {
  const raw = scrubFormatting(researchText);
  const allowlist = ownDomainAllowlist(
    groundTruth && groundTruth.businessWebsite,
    groundTruth && groundTruth.handles
  );

  const verification = {
    checked:          false,
    removedCount:     0,
    removed:          [],
    identityConflict: false,
    foreignDomains:   [],
    verifiedAt:       new Date().toISOString(),
  };

  if (!raw) {
    return { text: "", excerpts: [], verification };
  }

  // Model pass first: it can rewrite around a bad claim, which preserves
  // more good content than the blunt sentence-level guards can.
  let working = raw;
  const out = await callClaude({
    system:      VERIFY_SYSTEM,
    prompt:      buildVerifyPrompt(raw, groundTruth),
    model:       VERIFY_MODEL,
    maxTokens:   VERIFY_MAX_TOKENS,
    temperature: 0,
  });
  const parsed = out ? extractJsonObject(out.text) : null;
  if (parsed && typeof parsed.verified_text === "string") {
    verification.checked = true;
    working = scrubFormatting(parsed.verified_text);
    if (Array.isArray(parsed.removed)) {
      verification.removed = parsed.removed
        .filter(r => typeof r === "string" && r.trim())
        .map(r => r.trim().slice(0, 160))
        .slice(0, 8);
    }
    verification.identityConflict = !!parsed.identity_conflict;
  } else if (out) {
    // The call succeeded but the reply didn't parse — the brief is
    // unverified, and the deterministic guards below are all it gets.
    console.warn("[research-verify] unparseable verifier reply");
  }

  // Deterministic guards run unconditionally, over whatever the model
  // returned. They are the reason a verifier failure degrades instead of
  // regressing: the specific defect that started this — a foreign brand
  // stated as fact — cannot survive them.
  const hedged = dropHardHedges(working);
  if (hedged.removed.length) {
    verification.removed.push(...hedged.removed.map(
      s => "Cut a guess VIRL couldn't stand behind: “" + snippet(s, 110) + "”"
    ));
  }

  const guarded = dropForeignBrandSentences(hedged.text, allowlist);
  if (guarded.removed.length) {
    verification.identityConflict = true;
    verification.foreignDomains   = guarded.domains;
    verification.removed.push(
      "Cut " + (guarded.removed.length === 1 ? "a claim" : guarded.removed.length + " claims")
      + " about " + guarded.domains.join(", ") + " — that isn't a site you gave VIRL, so it isn't your business."
    );
    console.warn("[research-verify] foreign domains dropped:", guarded.domains.join(","));
  }

  verification.removedCount = verification.removed.length;
  verification.removed      = verification.removed.slice(0, 8);

  // Excerpts are supposed to be verbatim quotes from the creator's own
  // posts. One that names a foreign brand is not a quote from them, so
  // the same guard applies — a fabricated excerpt is worse than a
  // missing one, since excerpts feed the voice reference directly.
  const cleanExcerpts = (Array.isArray(excerpts) ? excerpts : [])
    .map(e => scrubFormatting(e))
    .filter((e) => {
      if (!e) return false;
      return dropForeignBrandSentences(e, allowlist).removed.length === 0;
    });

  return { text: guarded.text.trim(), excerpts: cleanExcerpts, verification };
}
