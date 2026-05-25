// [COMPLIANCE 1] Compliance rules loader + post-generation scrubber.
//
// Backs the marketing-page promise that VIRL produces materially safer
// content for Real Estate (Fair Housing / EHO / NAR) and Wellness
// (FDA / FTC) creators. Two complementary mechanisms:
//
//   1. PROMPT-LEVEL block — buildComplianceBlock() returns a constant
//      string that prompts.js appends to the cached system-prompt prefix
//      so every generation in scope rides the same per-niche guardrails.
//   2. POST-GENERATION SCRUB — scrubCompliance() walks the parsed model
//      output, applies a denylist of regex patterns, and either rewrites
//      flagged phrases (when the rule has a non-null replacement) or
//      flags them for telemetry (when replacement is null).
//
// Rules are stored in Supabase (compliance_sources + compliance_rules,
// migration 003) so the marketing claim is backed by canonical agency
// sources rather than vibes hardcoded in the prompt. Only status='approved'
// rows ever reach generation — the ingestion cron produces drafts that
// wait for human review.
//
// FAIL-OPEN: if the loader errors or the DB returns nothing, callers fall
// through to FLOOR_RULES below — a small, conservative hardcoded set so
// the product is never less safe than today even with an empty DB.

import { nicheCategory } from "./prompts.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// In-process cache — rules change rarely (weekly cron + occasional
// human approval), so a 10-minute TTL keeps the read path off Supabase
// on hot paths without making the human-review feedback loop feel slow.
const CACHE_TTL_MS = 10 * 60 * 1000;
let _cache = null;
let _cacheAt = 0;

// ── Safe-defaults floor ──────────────────────────────────────────────────
// Conservative hardcoded rules that fire when the DB has zero approved
// rows for a niche+locale. Designed so false positives are rare:
// patterns are anchored on word boundaries and high-context phrases.
// When a human approves DB rules, the loader merges them on top of this
// floor (DB denylist entries are appended; the floor's compliance_note
// stays if the DB has none of its own).
//
// Real estate: HUD Fair Housing red flags + clear value-claim violations.
// Wellness:    FDA disease-claim verbs + FTC marketing claim flags.
const FLOOR_RULES = {
  real_estate: {
    US: {
      rule_text:
        "You are writing for a licensed US real estate agent. Follow these constraints in every post:\n"
        + "  1. FAIR HOUSING (HUD): Never reference or imply preference for protected classes — race, color, religion, sex, disability, familial status, or national origin. Use feature-based language ('spacious layout', 'quiet street', 'near [named amenity]') instead of demographic language. NEVER write 'perfect for families', 'great for empty nesters', 'bachelor pad', 'Christian community', 'safe neighborhood', or 'near a church/synagogue/mosque'.\n"
        + "  2. EHO DISCLOSURE: On any post that markets a specific listing, include a 'compliance_note' field on the card suggesting the agent append their Equal Housing Opportunity logo/disclosure and brokerage license number per their broker's social media policy.\n"
        + "  3. NO GUARANTEED CLAIMS: Never write 'guaranteed appreciation', 'guaranteed ROI', 'risk-free investment', 'this will double in value'. Use 'historically', 'has appreciated', 'may', 'could'.\n"
        + "  4. MLS DATA: If a card cites a specific market stat (median price, days on market), add a compliance_note: 'Source: your local MLS, [month year]'. Do not invent specific numbers.\n"
        + "  5. REALTOR® MARK: Do not use the REALTOR® term — the creator's NAR membership is not on file. Use 'real estate agent'.",
      denylist: [
        // Fair Housing — clear-cut rewrites.
        { pattern: "\\bperfect for families\\b",                                              flags: "gi", replacement: "ideal for a wide range of buyers" },
        { pattern: "\\bgreat for families\\b",                                                flags: "gi", replacement: "great for a wide range of buyers" },
        { pattern: "\\bbachelor pad\\b",                                                      flags: "gi", replacement: "well-laid-out home" },
        { pattern: "\\bsafe neighborhood\\b",                                                 flags: "gi", replacement: "well-located neighborhood" },
        { pattern: "\\bexclusive neighborhood\\b",                                            flags: "gi", replacement: "established neighborhood" },
        // Fair Housing — flag-only (model should fix; rewrite would distort meaning).
        { pattern: "\\bideal for empty[- ]?nesters?\\b",                                      flags: "gi", replacement: null },
        { pattern: "\\bno children\\b",                                                       flags: "gi", replacement: null },
        { pattern: "\\b(?:christian|jewish|muslim|catholic) (?:community|neighborhood|area)\\b", flags: "gi", replacement: null },
        { pattern: "\\b(?:near|close to|walking distance to) (?:church|synagogue|mosque|temple)\\b", flags: "gi", replacement: null },
        // Value / return claims — flag-only so the model rewrites in context.
        { pattern: "\\bguaranteed (?:appreciation|roi|returns?|investment)\\b",               flags: "gi", replacement: null },
        { pattern: "\\brisk[- ]free investment\\b",                                           flags: "gi", replacement: null },
        { pattern: "\\bwill double in value\\b",                                              flags: "gi", replacement: null },
        // REALTOR mark — flag-only; rewrite distorts attribution.
        { pattern: "\\brealtor®\\b",                                                     flags: "gi", replacement: null },
      ],
      compliance_note:
        "Add your brokerage name + license number per your broker's social media policy. "
        + "Include an Equal Housing Opportunity disclosure on listing posts.",
    },
  },
  wellness: {
    US: {
      rule_text:
        "You are writing for a US wellness practitioner. Follow these constraints (FDA + FTC) in every post:\n"
        + "  1. NO DISEASE CLAIMS: Never write 'cures', 'heals', 'diagnoses', 'reverses [disease]', 'eliminates anxiety', 'kills cancer cells', or any verb-of-action paired with a disease name. Prefer structure/function phrasing: 'supports healthy digestion', 'may help maintain energy', 'promotes restful sleep', 'associated with'.\n"
        + "  2. SUPPLEMENT DISCLAIMER: If a post mentions a specific supplement, herb, or product, add a 'compliance_note' on the card: 'These statements have not been evaluated by the FDA. Not intended to diagnose, treat, cure, or prevent any disease.'\n"
        + "  3. TESTIMONIALS / CLIENT WINS: If a post features a specific result or client win, add a compliance_note: 'Individual results may vary.'\n"
        + "  4. NO PRESCRIBING: The creator is not a licensed physician unless their profile says so. Never write 'prescription', 'dosage', or 'I recommend [drug]'. Use 'talk to your doctor about', 'consider asking a clinician'.\n"
        + "  5. CLIENT PRIVACY: If a post identifies a specific client by name, photo, or identifying detail, add a compliance_note: 'Confirm written client consent before posting identifying details.'",
      denylist: [
        // FDA disease-claim verbs — flag-only. Rewriting these without
        // context (e.g. "cures cancer" → ?) risks producing weirder copy
        // than telling the model to retry. Anchored to avoid bakery
        // "treats" false positives.
        { pattern: "\\bcure[sd]?\\b",                                                         flags: "gi", replacement: null },
        { pattern: "\\bheal[sd]?\\s+(?:your|the|a|my)\\s+\\w+\\b",                            flags: "gi", replacement: null },
        { pattern: "\\bdiagnose[sd]?\\b",                                                     flags: "gi", replacement: null },
        { pattern: "\\breverses?\\s+(?:diabetes|cancer|aging|disease|illness)\\b",            flags: "gi", replacement: null },
        { pattern: "\\beliminate[sd]?\\s+(?:anxiety|depression|pain|inflammation|stress)\\b", flags: "gi", replacement: null },
        // FTC marketing claims — flag-only.
        { pattern: "\\bclinically proven\\b",                                                 flags: "gi", replacement: null },
        { pattern: "\\bdoctor[- ]recommended\\b",                                             flags: "gi", replacement: null },
        { pattern: "\\bFDA[- ]approved\\b",                                                   flags: "gi", replacement: null },
        { pattern: "\\bguaranteed results?\\b",                                               flags: "gi", replacement: null },
        { pattern: "\\bmiracle (?:cure|treatment|drug|supplement|pill)\\b",                   flags: "gi", replacement: null },
        // Prescribing language — flag-only.
        { pattern: "\\b(?:i|we) recommend\\s+(?:taking\\s+)?\\d+\\s*(?:mg|g|mcg|iu)\\b",      flags: "gi", replacement: null },
        { pattern: "\\bprescription\\s+(?:strength|dose|dosage)\\b",                          flags: "gi", replacement: null },
      ],
      compliance_note:
        "These statements have not been evaluated by the FDA. "
        + "Not intended to diagnose, treat, cure, or prevent any disease. "
        + "Individual results may vary.",
    },
  },
};

// US is the only locale with coverage in v1. The block / scrub no-op for
// any other locale string. When a per-user country field ships, pass it
// through from the profile; until then everyone resolves to "US".
const SUPPORTED_LOCALES = new Set(["US"]);

// Only these niche keys (the output of prompts.js#nicheCategory) get the
// compliance treatment in phase 1. Food & Recipes maps to "wellness" via
// nicheCategory, so it inherits the FDA framing (intentional).
const SUPPORTED_NICHES = new Set(["real_estate", "wellness"]);

// ── Loader ────────────────────────────────────────────────────────────────
// Reads compliance_rules WHERE status='approved' joined to compliance_sources.
// For each (niche, locale, category, source_url), keeps the highest approved
// version (so an old approved row stays usable until a human explicitly
// retires it after approving a new draft). Returns a nested map keyed by
// niche → locale → { rule_texts[], denylist[], compliance_notes[] }.
// Returns {} on any error — callers fall through to FLOOR_RULES.
export async function loadComplianceRules() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return {};
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/compliance_rules`
      + `?status=eq.approved`
      + `&select=version,rule_text,denylist,compliance_note,compliance_sources!inner(niche,locale,category,source_url)`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) {
      _cache = {}; _cacheAt = now;
      return _cache;
    }
    const rows = await res.json();

    // Group by (niche, locale, category, source_url) and keep the row with
    // the highest version per group. Then collapse into the niche/locale map.
    const bestByKey = new Map();
    for (const row of rows) {
      const src = row && row.compliance_sources;
      if (!src || !src.niche || !src.locale) continue;
      const key = src.niche + "|" + src.locale + "|" + src.category + "|" + src.source_url;
      const prev = bestByKey.get(key);
      if (!prev || (row.version || 0) > (prev.version || 0)) {
        bestByKey.set(key, row);
      }
    }

    const map = {};
    for (const row of bestByKey.values()) {
      const src = row.compliance_sources;
      const n = src.niche, l = src.locale;
      if (!map[n]) map[n] = {};
      if (!map[n][l]) map[n][l] = { rule_texts: [], denylist: [], compliance_notes: [] };
      if (row.rule_text) map[n][l].rule_texts.push(row.rule_text);
      if (Array.isArray(row.denylist)) map[n][l].denylist.push(...row.denylist);
      if (row.compliance_note) map[n][l].compliance_notes.push(row.compliance_note);
    }
    _cache = map; _cacheAt = now;
    return _cache;
  } catch (e) {
    _cache = {}; _cacheAt = now;
    return _cache;
  }
}

// Resolve the effective compliance bundle for a niche label (the user-facing
// niche string from params, e.g. "Real Estate" or "Wellness") + locale.
// Merges DB-approved rules on top of the FLOOR_RULES safe defaults so the
// floor is always the minimum guardrail — never replaced, only augmented.
// Returns null when the niche is out of scope or the locale isn't supported.
export function getComplianceForNiche(loaded, nicheLabel, locale) {
  const loc = locale || "US";
  if (!SUPPORTED_LOCALES.has(loc)) return null;
  const nicheKey = nicheCategory(nicheLabel);
  if (!SUPPORTED_NICHES.has(nicheKey)) return null;

  const floor = (FLOOR_RULES[nicheKey] && FLOOR_RULES[nicheKey][loc]) || null;
  const db    = (loaded && loaded[nicheKey] && loaded[nicheKey][loc]) || null;

  if (!floor && !db) return null;

  // Floor always lands first so a re-pull adding a draft can't accidentally
  // weaken the baseline if a reviewer approves something incomplete.
  const rule_texts        = [];
  const denylist          = [];
  const compliance_notes  = [];
  if (floor) {
    if (floor.rule_text) rule_texts.push(floor.rule_text);
    if (Array.isArray(floor.denylist)) denylist.push(...floor.denylist);
    if (floor.compliance_note) compliance_notes.push(floor.compliance_note);
  }
  if (db) {
    if (Array.isArray(db.rule_texts))       rule_texts.push(...db.rule_texts);
    if (Array.isArray(db.denylist))         denylist.push(...db.denylist);
    if (Array.isArray(db.compliance_notes)) compliance_notes.push(...db.compliance_notes);
  }

  return { nicheKey, locale: loc, rule_texts, denylist, compliance_notes };
}

// ── Prompt-level block ────────────────────────────────────────────────────
// Builds the system-prompt block that's appended to the cached prefix in
// every in-scope builder. Returns "" when the niche/locale is out of scope
// so callers can append unconditionally.
export function buildComplianceBlock(complianceForNiche) {
  if (!complianceForNiche) return "";
  const { nicheKey, rule_texts, compliance_notes } = complianceForNiche;
  if (!rule_texts.length) return "";

  const header = nicheKey === "real_estate"
    ? "COMPLIANCE GUARDRAILS — REAL ESTATE (US)"
    : "COMPLIANCE GUARDRAILS — WELLNESS (US)";

  const noteBlock = compliance_notes.length
    ? "\n\nSUGGESTED COMPLIANCE NOTES — use the `compliance_note` field on plan cards / script / caption / scan outputs when a post touches one of the situations above. Example texts a creator might paste into their post:\n  - "
      + compliance_notes.join("\n  - ")
    : "";

  return "\n\n" + header + ":\n" + rule_texts.join("\n\n") + noteBlock
    + "\n\nOPTIONAL OUTPUT FIELD: every JSON output object in scope (plan cards, scripts, caption results, scan results) MAY include a `compliance_note` string when one of the situations above applies to that specific output. Omit the field when no disclosure is warranted. Do not invent compliance language that is not grounded in the rules above.";
}

// ── Post-generation scrub ────────────────────────────────────────────────
// Walks every string in the parsed model output and applies the niche's
// denylist. Rules with a string `replacement` rewrite in place; rules with
// `replacement: null` are flagged but left as-is for the creator to resolve
// (false positives are worse than false negatives at this layer — see the
// design note at the top of this file).
//
// Returns { scrubbed, flags } where `scrubbed` is the same parsed object
// (mutated in place — callers pass a fresh JSON.parse'd value) and
// `flags` is an array of { pattern, original, rewritten? } records that
// the caller surfaces to telemetry and (eventually) to the UI.

// Keys to skip during the walk: controlled vocabulary or non-text values
// that should never be regex-rewritten. `compliance_note` itself is also
// skipped — it's the disclaimer text the scrub is suggesting to add, and
// rewriting "cure" inside "not intended to cure" would be exactly wrong.
const SKIP_KEYS = new Set([
  "format", "platform", "day", "postTime", "priority", "slideNumber",
  "frameNumber", "score", "duration", "compliance_note", "compliance_flags",
  "hashtags", "audioSuggestion", "audioRecommendation",
  // Stats inside plan output are numeric strings ("45000", "6.2%") — no
  // benefit to scanning and the engagement % regex on "guaranteed" never
  // matches a stat key anyway.
  "stats", "reach", "engagement", "earnings",
  // Internal infra fields.
  "trend",
]);

function compileRule(rule) {
  try {
    const flags = rule.flags || "gi";
    // Force global flag so a pattern with multiple matches in a single
    // string is fully rewritten, not just the first occurrence.
    const gFlags = flags.indexOf("g") >= 0 ? flags : flags + "g";
    return new RegExp(rule.pattern, gFlags);
  } catch (e) {
    return null;
  }
}

function scrubString(str, compiledRules, flags, path) {
  if (typeof str !== "string" || !str) return str;
  let out = str;
  for (const cr of compiledRules) {
    cr.re.lastIndex = 0;
    if (!cr.re.test(out)) continue;
    cr.re.lastIndex = 0;
    if (cr.rule.replacement === null || cr.rule.replacement === undefined) {
      // Flag-only.
      const m = out.match(cr.re);
      flags.push({
        pattern:    cr.rule.pattern,
        rewritten:  false,
        original:   m && m[0] ? m[0] : "",
        path:       path || "",
      });
    } else {
      const before = out;
      out = out.replace(cr.re, cr.rule.replacement);
      if (before !== out) {
        flags.push({
          pattern:    cr.rule.pattern,
          rewritten:  true,
          original:   before.match(new RegExp(cr.rule.pattern, "i")) ? before.match(new RegExp(cr.rule.pattern, "i"))[0] : "",
          replacement: cr.rule.replacement,
          path:       path || "",
        });
      }
    }
  }
  return out;
}

function walkAndScrub(node, compiledRules, flags, path) {
  if (node == null) return node;
  if (typeof node === "string") return scrubString(node, compiledRules, flags, path);
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      node[i] = walkAndScrub(node[i], compiledRules, flags, path + "[" + i + "]");
    }
    return node;
  }
  if (typeof node === "object") {
    for (const k of Object.keys(node)) {
      if (SKIP_KEYS.has(k)) continue;
      node[k] = walkAndScrub(node[k], compiledRules, flags, path ? path + "." + k : k);
    }
    return node;
  }
  return node;
}

export function scrubCompliance(complianceForNiche, parsed) {
  if (!parsed || typeof parsed !== "object") return { scrubbed: parsed, flags: [] };
  if (!complianceForNiche || !Array.isArray(complianceForNiche.denylist) || !complianceForNiche.denylist.length) {
    return { scrubbed: parsed, flags: [] };
  }
  const compiledRules = complianceForNiche.denylist
    .map(rule => ({ rule, re: compileRule(rule) }))
    .filter(cr => cr.re);
  if (!compiledRules.length) return { scrubbed: parsed, flags: [] };

  const flags = [];
  walkAndScrub(parsed, compiledRules, flags, "");
  return { scrubbed: parsed, flags };
}

// Test-only export — lets scripts/check-compliance.mjs exercise the floor
// directly without spinning up a Supabase fixture for the simple cases.
// Not part of the production surface; the loader is the supported entry
// point for prod code paths.
export const __TEST_ONLY__ = { FLOOR_RULES, SUPPORTED_LOCALES, SUPPORTED_NICHES };
