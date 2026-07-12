// [VOICE-FEED] Returns the verbatim post excerpts handle-research already
// pulled from the user's public accounts, so the profile UI can offer
// one-tap "keep as voice sample" confirmation. Confirmed excerpts become
// authored-grade voice_samples – the single biggest voice-quality lever
// for profiles that currently run on adjectives.
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: "Server misconfigured." });
  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!auth) return res.status(401).json({ error: "Sign in required." });
  let user;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${auth}`, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Sign in required." });
    user = await userRes.json();
  } catch (e) { return res.status(401).json({ error: "Sign in required." }); }
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/creator_handle_research?user_id=eq.${user.id}&select=post_excerpts`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!r.ok) return res.status(200).json({ excerpts: [] });
    const rows = await r.json();
    const excerpts = (rows[0] && Array.isArray(rows[0].post_excerpts) ? rows[0].post_excerpts : [])
      .filter(s => typeof s === "string" && s.trim().length > 20)
      .slice(0, 6);
    return res.status(200).json({ excerpts });
  } catch (e) { return res.status(200).json({ excerpts: [] }); }
}
