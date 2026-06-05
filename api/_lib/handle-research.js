// [HANDLE-RESEARCH] Per-user Perplexity research on the creator's actual
// social presence — what topics they post about, their voice/tone, visual
// signatures. Threaded into the system prompt as additional creator
// context so generations don't have to guess at a profile we could just
// look up.
//
// Pattern mirrors api/_lib/trends-research.js (Perplexity Sonar wrapper +
// best-effort parsing + fail-open semantics). Differences:
//   - Cached per-user in creator_handle_research instead of per-platform
//     in latest_trends.
//   - 30-day TTL instead of 7-day — a creator's voice doesn't shift weekly.
//   - Refresh keyed on handles_hash so swapping/adding a handle forces a
//     re-fetch independent of the TTL.
//   - Returns plain-text research (one paragraph + bullet list) rather
//     than the structured items array trends-research builds.

import crypto from "node:crypto";
import { callPerplexity } from "./perplexity.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Refresh research older than this OR when the handles change.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Deterministic, content-addressable signature of a handles object so a
// row's handles_hash trivially tells us whether the cached research is
// still about the right set of accounts. Sorted keys to keep
// {tiktok, instagram} === {instagram, tiktok}.
function hashHandles(handles) {
  if (!handles || typeof handles !== "object") return "";
  const sorted = Object.keys(handles)
    .filter(k => handles[k])
    .sort()
    .map(k => k.toLowerCase() + ":" + String(handles[k]).trim().toLowerCase());
  return crypto.createHash("sha256").update(sorted.join("|")).digest("hex");
}

// Reads the cached research row. Returns null on any failure (network,
// missing table) so callers degrade to "skip the research block" rather
// than failing the whole generation.
async function readCache(userId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !userId) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/creator_handle_research?user_id=eq.${userId}&select=research_text,handles_hash,fetched_at`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows && rows[0] ? rows[0] : null;
  } catch (e) { return null; }
}

// Upserts the cache. Fire-and-forget from the caller's perspective.
async function writeCache(userId, research_text, handles_hash) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !userId) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/creator_handle_research`, {
      method: "POST",
      headers: {
        apikey:           SUPABASE_SERVICE_KEY,
        Authorization:    `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type":   "application/json",
        Prefer:           "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        user_id:       userId,
        research_text,
        handles_hash,
        fetched_at:    new Date().toISOString(),
      }),
    });
  } catch (e) { /* non-fatal */ }
}

// Builds the Perplexity prompt. Keeps it tight — we want a short, dense
// paragraph the LLM can actually use, not a research paper. The prompt
// explicitly tells Perplexity to flag uncertainty rather than confabulate.
function buildResearchPrompt(handles) {
  const handleList = Object.keys(handles)
    .filter(k => handles[k])
    .map(k => k + ": " + String(handles[k]).trim())
    .join(", ");
  return [
    "Research this creator's actual posting patterns across their connected platforms.",
    "",
    "Handles: " + handleList,
    "",
    "Look at what's publicly visible. Surface:",
    "  1. What topics or themes do they consistently post about? (3-5 specific ones)",
    "  2. What's their voice / tone like? Pick concrete adjectives (warm, dry, conversational, authoritative, irreverent, etc.) — not generic praise.",
    "  3. What visual signature, if any? (e.g. 'always shot outdoors,' 'high-contrast B&W,' 'kitchen flat-lays,' 'screen-recorded tutorials')",
    "  4. Any recurring phrases, sign-offs, or in-jokes that show up in their captions?",
    "",
    "Be honest about uncertainty. If a handle returns very few indexable posts, say so plainly — DO NOT invent details. If the creator is small / new and you find nothing useful, return EXACTLY this string and nothing else: NO_USEFUL_RESEARCH",
    "",
    "Return ONE tight paragraph (max 8 sentences) summarizing 1-4 above. No headings, no bullet points. No marketing language. Treat this as a brief to another writer who needs to sound like this person.",
  ].join("\n");
}

// Public entry. Returns a string suitable for direct injection into the
// system prompt, OR null when:
//   - No handles configured
//   - Perplexity not configured / errored
//   - Perplexity returned NO_USEFUL_RESEARCH
//
// Caller (buildProfileCtx) skips the research block on null. Cache TTL is
// 30 days; handles_hash refresh is immediate on handle change.
export async function fetchHandleResearch(userId, handles) {
  if (!userId || !handles || typeof handles !== "object") return null;
  const wanted = Object.keys(handles).filter(k => handles[k]).length;
  if (wanted === 0) return null;

  const currentHash = hashHandles(handles);
  const cached = await readCache(userId);
  if (cached && cached.handles_hash === currentHash) {
    const ageMs = Date.now() - Date.parse(cached.fetched_at || 0);
    if (Number.isFinite(ageMs) && ageMs < TTL_MS) {
      return cached.research_text || null;
    }
  }

  // Cache miss / stale / handles changed → re-fetch.
  const out = await callPerplexity({
    prompt:    buildResearchPrompt(handles),
    model:     "sonar",
    maxTokens: 600,
  });
  if (!out || typeof out.text !== "string") return null;
  const text = out.text.trim();
  if (!text || text === "NO_USEFUL_RESEARCH") {
    // Cache the negative result with the current hash so we don't fire
    // again until either the handles change or the TTL expires.
    writeCache(userId, "", currentHash).catch(() => {});
    return null;
  }
  writeCache(userId, text, currentHash).catch(() => {});
  return text;
}
