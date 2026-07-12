// /api/me-credits.js
// ─────────────────────────────────────────────────────────────────────────────
// [CX-FIX 6] Server-side credits-row fetch – fallback for the client's direct
// PostgREST fetch. Some accounts (Lauren's, for one – bug present for months)
// can't load their credits row through PostgREST + the user's JWT. The client
// gets null silently and the HUD shows "–" forever. This endpoint bypasses
// whatever's wrong on the RLS / token path by reading with the service key.
//
// Auth: bearer token verified against Supabase. The user_id comes from the
// verified token – never trust a client-supplied id here.
//
// Returns:
//   200 { credits: row }      – the user's credits row
//   200 { credits: null }     – no row exists for this user (lazy-provisioned)
//   401 { error }             – invalid / missing token
//   500 { error }             – server config issue
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Sign in required." });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }

  let userId;
  try {
    const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Sign in required." });
    const u = await userRes.json();
    userId = u && u.id;
    if (!userId) return res.status(401).json({ error: "Sign in required." });
  } catch (e) {
    return res.status(401).json({ error: "Sign in required." });
  }

  try {
    const r = await fetch(
      SUPABASE_URL + "/rest/v1/credits?user_id=eq."
        + encodeURIComponent(userId)
        + "&select=credits,plan,reset_at,fresh_trends_plan_remaining,fresh_trends_scan_remaining,fresh_trends_caption_remaining,founding_tier,founding_position"
        + "&limit=1",
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
        },
      }
    );
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("[me-credits] credits fetch failed:", r.status, text);
      return res.status(500).json({ error: "Could not load credits." });
    }
    const rows = await r.json();
    const row  = (Array.isArray(rows) && rows.length > 0) ? rows[0] : null;
    return res.status(200).json({ credits: row });
  } catch (e) {
    console.error("[me-credits] threw:", e.message);
    return res.status(500).json({ error: "Could not load credits." });
  }
}
