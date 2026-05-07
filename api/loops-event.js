// [PREMIUM 3] Proxy endpoint that fires a Loops event for the current
// user. Built initially for the tenPlansMilestone celebration in
// PREMIUM 3 — PREMIUM 7 will reuse this endpoint for the rest of the
// lifecycle email triggers (welcome, profile-incomplete, trial-end,
// subscription-started, etc).
//
// Graceful degradation: if LOOPS_API_KEY is not set, this returns 200
// with { ok: true, note: "..." } so the client never sees an error
// and no in-app flow blocks on Loops being configured. Same for any
// upstream failure from Loops itself — we surface it to the server
// log and quietly succeed to the client.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.LOOPS_API_KEY;

  // Auth: require a Supabase bearer token so a random caller can't
  // fire arbitrary events into Loops in someone else's name.
  const authHeader = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!authHeader) {
    return res.status(401).json({ error: "Sign in required." });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }
  let authedUserId, authedEmail;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${authHeader}`, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Sign in required." });
    const u = await userRes.json();
    authedUserId = u.id;
    authedEmail  = u.email;
  } catch (e) {
    return res.status(401).json({ error: "Sign in required." });
  }

  const { eventName, properties } = req.body || {};
  if (!eventName || typeof eventName !== "string") {
    return res.status(400).json({ error: "eventName required" });
  }

  // [PREMIUM 3] Loops not configured — succeed silently so the client
  // doesn't have to know about deployment state.
  if (!apiKey) {
    console.warn("[loops-event] LOOPS_API_KEY not set; skipping event:", eventName);
    return res.status(200).json({ ok: true, note: "Loops not configured" });
  }

  try {
    const response = await fetch("https://app.loops.so/api/v1/events/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId:          authedUserId,
        email:           authedEmail,
        eventName:       eventName,
        eventProperties: properties || {},
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn("[loops-event] Loops returned " + response.status, text);
      return res.status(200).json({ ok: false });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[loops-event] error:", err.message);
    return res.status(200).json({ ok: false });
  }
}
