// [PREMIUM 7] Auth-required proxy endpoint that lets the browser fire
// a Loops event for the *signed-in* user. Server-side callers (Stripe
// webhook, cron) should import api/_lib/loops.js directly rather than
// HTTP through this proxy. Originally built in PREMIUM 3 for the
// tenPlansMilestone trigger; PREMIUM 7 refactored it to delegate to
// the shared helper so all Loops calls share one implementation.

import { sendLoopsEvent } from "./_lib/loops.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

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

  // Always 200 to the client — Loops failures are non-blocking.
  const out = await sendLoopsEvent({
    userId:     authedUserId,
    email:      authedEmail,
    eventName:  eventName,
    properties: properties,
  });
  return res.status(200).json(out);
}
