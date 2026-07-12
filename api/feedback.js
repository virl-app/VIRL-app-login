// User-facing feedback submit endpoint. Auth-required (so we know who
// sent it) but writes via service-role so it bypasses RLS – there are no
// client-readable policies on public.feedback.
//
// POST body: {
//   sentiment?: "happy" | "neutral" | "sad",
//   message:   string (required, max 2000 chars),
//   context?:  string (e.g. the active tab name when feedback was opened)
// }

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ALLOWED_SENTIMENTS = new Set(["happy", "neutral", "sad"]);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }

  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!auth) return res.status(401).json({ error: "Sign in required." });

  // Verify the bearer token belongs to a real Supabase user. Same pattern
  // as chat.js – never trust a client-supplied user_id.
  let user;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${auth}`, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Sign in required." });
    user = await userRes.json();
  } catch (e) {
    return res.status(401).json({ error: "Sign in required." });
  }

  // Burst limit: a signed-in user can't flood the feedback table / admin inbox.
  // Reuses the same service-role RPC chat.js uses; failures fail-open so a
  // Supabase blip never blocks legitimate feedback.
  try {
    const rl = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_and_record_rate_limits`, {
      method: "POST",
      headers: {
        apikey:        SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_user_id: user.id, p_endpoint: "feedback", p_minute_max: 3, p_hour_max: 20 }),
    });
    if (rl.ok && (await rl.json()) !== "ok") {
      return res.status(429).json({ error: "You're sending feedback too quickly – please try again in a bit." });
    }
  } catch (e) { /* fail-open */ }

  const body = req.body || {};
  const message = (body.message || "").trim();
  if (!message) return res.status(400).json({ error: "Message is required." });
  if (message.length > 2000) return res.status(400).json({ error: "Message too long (max 2000 chars)." });

  const sentiment = ALLOWED_SENTIMENTS.has(body.sentiment) ? body.sentiment : null;
  const context   = typeof body.context === "string" ? body.context.slice(0, 100) : null;

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/feedback`, {
      method: "POST",
      headers: {
        apikey:        SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer:        "return=minimal",
      },
      body: JSON.stringify({
        user_id:    user.id,
        user_email: user.email || null,
        sentiment,
        message,
        context,
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("[feedback] insert failed", r.status, text);
      return res.status(500).json({ error: "Could not save feedback." });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[feedback] threw", e.message);
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
