// [HANDLE-RESEARCH-PREWARM] Endpoint the client fires from
// saveProfileToSupabase the moment a profile save with handles succeeds,
// so the Perplexity research call happens BEFORE the user's first plan
// generation instead of adding ~3s of latency to it. Idempotent against
// fetchHandleResearch's cache — repeated calls with unchanged handles
// are zero-cost no-ops.
//
// Auth: same Bearer-token pattern as /api/email/welcome, /api/loops-event.
// The endpoint only ever reads / writes research for the *authenticated*
// user_id — handles are server-fetched from auth.users via the token, not
// trusted from request body — so a malicious caller can't pre-warm someone
// else's cache or burn another user's Perplexity budget.
//
// Failure semantics: always returns 200 with { refreshed, reason } so the
// client's fire-and-forget never sees an error. The actual Perplexity call
// is fail-open inside fetchHandleResearch — if Perplexity is down, we
// return { refreshed: false, reason: "no_research" } and the next plan
// generation just runs without the research block.

import { fetchHandleResearch } from "./_lib/handle-research.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Sign in required." });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }

  // Verify the bearer token + resolve the user_id.
  let userId;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!r.ok) return res.status(401).json({ error: "Sign in required." });
    const u = await r.json();
    userId = u.id;
  } catch (e) {
    return res.status(401).json({ error: "Sign in required." });
  }
  if (!userId) return res.status(401).json({ error: "Sign in required." });

  // Read handles + inspiration + learn_from_public_posts from the profiles
  // table — NEVER trust the request body, since that would let a caller
  // pre-warm research against fabricated handles / aspirations and force
  // the cache to misrepresent the authenticated user. Inspiration is
  // included in the cache key (handles_hash), so it has to come from the
  // same trusted source.
  let handles = {};
  let inspiration = "";
  let learnFromPublicPosts = false;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=handles,inspiration,learn_from_public_posts`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (r.ok) {
      const rows = await r.json();
      handles              = (rows[0] && rows[0].handles && typeof rows[0].handles === "object") ? rows[0].handles : {};
      inspiration          = (rows[0] && typeof rows[0].inspiration === "string") ? rows[0].inspiration : "";
      learnFromPublicPosts = !!(rows[0] && rows[0].learn_from_public_posts);
    }
  } catch (e) { /* fail-open below */ }

  const hasAny = handles && Object.keys(handles).some(k => handles[k]);
  if (!hasAny) {
    return res.status(200).json({ refreshed: false, reason: "no_handles" });
  }

  // [LEARNING-CONSENT] Skip the Perplexity research call entirely when the
  // user has not opted in to learn_from_public_posts. Mirrors the gate in
  // chat.js — no third-party network request fires without consent.
  if (!learnFromPublicPosts) {
    return res.status(200).json({ refreshed: false, reason: "consent_off" });
  }

  // fetchHandleResearch is idempotent: returns cached text when fresh,
  // fires Perplexity + writes cache when stale or handles changed. Either
  // way the client's intent ("get the cache hot for the next generation")
  // is satisfied.
  let research = null;
  try {
    research = await fetchHandleResearch(userId, handles, inspiration);
  } catch (e) { /* fail-open */ }

  return res.status(200).json({
    refreshed: !!research,
    reason:    research ? "ok" : "no_research",
  });
}
