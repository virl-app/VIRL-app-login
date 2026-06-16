// /api/_lib/personal-denylist.js
// ─────────────────────────────────────────────────────────────────────────────
// [PERSONAL-DENYLIST] Mines the user's own edit history for phrases they
// consistently strip out of generated drafts, then surfaces those phrases
// as a per-creator denylist block in the system prompt.
//
// Rationale: STYLE_GUARD in prompts.js bans well-known AI-tells across all
// users ("delve into," "tapestry," "game-changing"). But every creator has
// their OWN tells — words the model keeps reaching for that THIS creator
// always removes. Mining the edit history makes the denylist self-tuning
// per user: the more they edit, the sharper the model's avoidance gets,
// without any manual configuration.
//
// Pipeline:
//   1. fetchEditsForMining — pull up to 50 recent edits from the events
//      table (plan_card_edited + draft_edited), bigger than the 8-diff
//      few-shot pool the prompt's editsCtx uses.
//   2. mineDenylistFromEdits — for each before/after pair, extract
//      phrases (1-3 word n-grams) that appear in `before` but NOT in
//      `after`. Accumulate frequencies across all diffs. Filter out
//      stopwords + already-banned vocabulary. Top N by frequency become
//      the personal denylist.
//   3. formatDenylistForPrompt — renders the result as a short prompt
//      block; returns "" when nothing crosses the frequency threshold
//      so the caller can concat unconditionally.
//
// Fail-soft everywhere: any DB error, empty edits, or thin signal
// returns an empty result and the prompt skips the block entirely. The
// generation itself never blocks on this.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const SUPABASE_HEADERS = {
  apikey:        SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
};

// Pull a larger batch of recent edits than the few-shot editsCtx uses.
// Mining wants statistical signal — one removed phrase across two edits
// is a coincidence, across five is a pattern. Limit chosen to bound the
// payload size: 50 edits × ~300 char diff = ~15KB max, comfortably under
// PostgREST's default response cap.
const MAX_EDITS_FOR_MINING = 50;

async function fetchEditsForMining(userId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return [];
  if (!userId) return [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/events`
      + `?user_id=eq.${userId}`
      + `&event_name=in.(plan_card_edited,draft_edited)`
      + `&select=properties,created_at`
      + `&order=created_at.desc`
      + `&limit=${MAX_EDITS_FOR_MINING}`;
    const res = await fetch(url, { headers: SUPABASE_HEADERS });
    if (!res.ok) return [];
    const rows = await res.json();
    const out = [];
    for (const row of rows) {
      const changes = row && row.properties && Array.isArray(row.properties.changes)
        ? row.properties.changes : null;
      if (!changes) continue;
      for (const c of changes) {
        if (!c || typeof c !== "object" || !c.field) continue;
        const before = (c.before || "").toString();
        const after  = (c.after  || "").toString();
        if (!after || before === after) continue;
        out.push({ before, after });
      }
    }
    return out;
  } catch (e) { return []; }
}

// Stopwords list. Function words + the most common content words that
// appear in everything. Without this filter the top-N denylist would be
// dominated by "the / a / and" noise. Kept small on purpose — over-
// filtering hides real signal. Lowercase, no punctuation.
const STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "be", "but", "by", "do", "does",
  "for", "from", "have", "i", "if", "in", "is", "it", "its", "me",
  "my", "no", "not", "of", "on", "or", "our", "out", "she", "so",
  "that", "the", "their", "they", "this", "to", "too", "us", "was",
  "we", "what", "when", "where", "who", "will", "with", "you", "your",
  "yours", "are", "am", "all", "any", "can", "had", "has", "her", "him",
  "his", "how", "now", "one", "two", "up", "down", "over", "off", "than",
  "then", "there", "these", "those", "very", "just", "like", "some",
  "such", "only", "really", "even", "much", "more", "most", "many",
  "into", "about", "after", "before", "between", "during", "while",
  "yes", "well", "okay", "ok", "got",
]);

// Lift STYLE_GUARD's banned-vocab list verbatim so the personal
// denylist doesn't duplicate phrases already in the shared block.
// Lowercase, comma-separated entries normalized. Trim parenthetical
// qualifiers like "(as a verb)" — those are documentation, not part
// of the phrase. Keep in sync with prompts.js STYLE_GUARD when that
// list changes; duplication is harmless (the model just sees the
// phrase twice) but wastes a few prompt tokens.
const GLOBAL_BANNED = new Set([
  "delve into", "dive into", "embark on", "navigate", "leverage",
  "unlock", "unleash", "harness",
  "in the realm of", "in today's digital landscape", "in this ever-changing", "in the world of",
  "tapestry", "labyrinth", "myriad", "plethora", "treasure trove", "kaleidoscope",
  "moreover", "furthermore", "in conclusion", "first and foremost", "that said",
  "let's dive in", "without further ado", "i hope this finds you well", "buckle up",
  "game-changing", "revolutionary", "groundbreaking", "cutting-edge", "next-level",
]);

// Minimum number of distinct edits a phrase must be removed in before
// it qualifies. Two is the smallest n where "the user is rejecting
// this phrase" reads as a pattern, not a one-off draft preference.
const MIN_FREQ = 2;

// Maximum personal-denylist entries to surface. Keeps the prompt block
// scannable + per-token-cost bounded. Empirically the long tail past
// 12 is low-signal anyway.
const MAX_ENTRIES = 12;

// Tokenize text into lowercase words. Strips punctuation, preserves
// contractions ("don't" stays glued), drops pure-numeric tokens.
function tokenize(text) {
  if (!text || typeof text !== "string") return [];
  const matches = text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g);
  return matches || [];
}

// All 1-3-grams from a token list. Returns array of phrase strings
// (joined by " "). Doesn't dedupe — a phrase appearing twice in `before`
// counts twice when accumulating, which is the right weighting (a phrase
// hammered repeatedly in one draft is stronger signal than one that
// happens to show up once across two drafts).
function ngrams(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    out.push(tokens[i]);
    if (i + 1 < tokens.length) out.push(tokens[i] + " " + tokens[i+1]);
    if (i + 2 < tokens.length) out.push(tokens[i] + " " + tokens[i+1] + " " + tokens[i+2]);
  }
  return out;
}

// Public: take an array of { before, after } diffs and return the top N
// phrases the user has consistently stripped out. Each phrase counted at
// MOST once per diff (so a single edit can't dominate the ranking by
// repeating a word ten times in one before-block).
//
// Empty array on no signal — caller skips the prompt block.
export function mineDenylistFromEdits(edits) {
  if (!Array.isArray(edits) || edits.length === 0) return [];

  const freq = new Map(); // phrase → number of distinct edits removing it

  for (const e of edits) {
    if (!e || typeof e !== "object") continue;
    const beforeTokens = tokenize(e.before);
    const afterTokens  = tokenize(e.after);
    if (beforeTokens.length === 0) continue;
    const afterSet = new Set(afterTokens);
    // Pre-compute the set of phrases present in `after` so we can
    // quickly skip n-grams from `before` that the user kept.
    const afterPhrases = new Set(ngrams(afterTokens));

    // Dedupe per-diff: a phrase removed across this edit counts as ONE
    // contribution to the cross-edit frequency, regardless of how many
    // times it appeared in `before`. Otherwise one verbose before-block
    // would swamp the ranking.
    const seenInThisDiff = new Set();

    const beforePhrases = ngrams(beforeTokens);
    for (const phrase of beforePhrases) {
      if (seenInThisDiff.has(phrase)) continue;
      // Filter — order matters, cheapest checks first.
      // 1. Phrase still present in `after` → user kept it; not a removal.
      if (afterPhrases.has(phrase)) continue;
      // 2. Pure stopword (only for 1-grams; compound phrases with
      //    stopwords are still meaningful e.g. "in the realm of").
      if (!phrase.includes(" ") && STOPWORDS.has(phrase)) continue;
      // 3. Already on the global STYLE_GUARD denylist — no point in
      //    bloating the per-user block with redundant entries.
      if (GLOBAL_BANNED.has(phrase)) continue;
      // 4. Word fragments under 3 characters (catches contraction
      //    artifacts like "'s", "'re" after tokenization edge cases,
      //    plus low-information words).
      if (!phrase.includes(" ") && phrase.length < 3) continue;
      // 5. Any word in the phrase shorter than 2 chars → noise.
      if (phrase.split(" ").some(w => w.length < 2)) continue;

      seenInThisDiff.add(phrase);
      freq.set(phrase, (freq.get(phrase) || 0) + 1);
    }
  }

  // Rank: frequency desc, then phrase length desc (compound phrases
  // are more specific signal than single words at the same count).
  // Then alphabetic for stable tie-breaking.
  const ranked = [];
  for (const [phrase, count] of freq.entries()) {
    if (count < MIN_FREQ) continue;
    ranked.push({ phrase, count });
  }
  ranked.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const aLen = a.phrase.length, bLen = b.phrase.length;
    if (bLen !== aLen) return bLen - aLen;
    return a.phrase.localeCompare(b.phrase);
  });

  // De-overlap: if a longer phrase is in the top list AND one of its
  // constituent unigrams is also in the list, drop the unigram. Keeps
  // the prompt focused on the most specific pattern.
  const final = [];
  const taken = new Set();
  for (const r of ranked) {
    if (final.length >= MAX_ENTRIES) break;
    const tokens = r.phrase.split(" ");
    // If any constituent word is already in `final` as a 1-gram, skip
    // — the multi-word entry will subsume it. Reverse case (1-gram
    // appearing after a multi-word that contains it) handled by the
    // same `taken` set: we add ALL constituent unigrams when we accept
    // a multi-word phrase, so subsequent unigrams are blocked.
    if (tokens.some(t => taken.has(t))) continue;
    final.push(r.phrase);
    if (tokens.length > 1) {
      for (const t of tokens) taken.add(t);
    } else {
      taken.add(r.phrase);
    }
  }
  return final;
}

// Render the denylist as a prompt block. Returns "" when the list is
// empty so the caller can concat the result unconditionally.
//
// Framing matters: this is THIS creator's denylist, not a generic
// banned list. The copy makes that explicit so the model treats it
// with the same "this is voice ground truth" weight as the vault
// exemplars and fingerprint.
export function formatDenylistForPrompt(phrases) {
  if (!Array.isArray(phrases) || phrases.length === 0) return "";
  const lines = phrases.map(p => "  - " + p);
  return "PERSONAL DENYLIST (phrases this creator has repeatedly removed from their own drafts — they don't sound like them, do not use them):\n"
    + lines.join("\n");
}

export { fetchEditsForMining };
