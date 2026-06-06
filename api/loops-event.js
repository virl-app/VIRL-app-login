// [PREMIUM 7] Auth-required proxy endpoint that lets the browser fire
// a Loops event for the *signed-in* user. Server-side callers (Stripe
// webhook, cron) should import api/_lib/loops.js directly rather than
// HTTP through this proxy. Originally built in PREMIUM 3 for the
// tenPlansMilestone trigger; PREMIUM 7 refactored it to delegate to
// the shared helper so all Loops calls share one implementation.

import { sendLoopsEvent } from "./_lib/loops.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// [SECURITY] Whitelist of Loops event names the BROWSER may fire on behalf
// of the authenticated user. Any other event must be fired SERVER-SIDE only
// (Stripe webhook, chat.js post-generation hooks, cron). Without this gate,
// a signed-in user could POST { eventName: "subscriptionStarted",
// properties: { foundingTier: "founder_circle" } } and trigger Loops to
// send them the founder-circle welcome email — and any other tier-aware
// sequence. Same risk for foundingCircleFull, thirtyDayMilestone, etc.
//
// To add a new client-firable event: add it here AND verify the Loops
// automation listening for it tolerates client triggering (e.g. doesn't
// grant credits, upgrade plans, etc).
const CLIENT_ALLOWED_EVENTS = new Set([
  "userSignedUp",         // first SIGNED_IN — fired from index.html signup handler
  "firstPlanGenerated",   // first plan ever — fired from index.html post-generation
  "fivePlansMilestone",   // plan #5 — fired from index.html post-generation
  "tenPlansMilestone",    // plan #10 — fired from index.html post-generation
]);

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
  // [SECURITY] Reject any event not in CLIENT_ALLOWED_EVENTS. Lifecycle
  // and billing events (subscriptionStarted, foundingCircleFull,
  // thirtyDayMilestone, signup_welcome, etc.) must only fire from
  // server-side code where the trigger is verifiable — not from whatever
  // a signed-in user can stuff into a POST body.
  if (!CLIENT_ALLOWED_EVENTS.has(eventName)) {
    return res.status(400).json({ error: "eventName not allowed from client." });
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
