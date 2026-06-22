// [PREMIUM 7] Shared Loops API helpers. Both api/loops-event.js (auth-
// required, called by the browser) and any server-side caller (Stripe
// webhooks, cron jobs) route through these so we have one place
// handling the Loops bearer token, response shape, and graceful
// degradation. If LOOPS_API_KEY is unset, every helper logs and
// resolves with { ok: false, note: "not configured" } — never throws.

import { claimSend } from "./email-send.js";

const LOOPS_API_BASE = "https://app.loops.so/api/v1";

function loopsApiKey() {
  return process.env.LOOPS_API_KEY || null;
}

// [LOOPS-PLAN] Map the app's internal Supabase `credits.plan` value to the
// `plan` contact property Loops audience filters key off. The trial-
// conversion workflows filter on `plan == "free"`, so a free/trial user
// must NEVER arrive blank — that's the bug this normalizer closes. Paid
// tiers pass through unchanged; cancelled / past_due are preserved so the
// reactivation + dunning segments still match; everything else (the string
// "free", "trial", null, "", or an unknown value) collapses to "free".
//
// Keep this the single source of truth for the property value so the signup
// path, the periodic cron sync, and the backfill all agree.
export function loopsPlanValue(supabasePlan) {
  const p = (supabasePlan == null ? "" : String(supabasePlan)).trim().toLowerCase();
  if (p === "founding" || p === "standard" || p === "pro") return p;
  if (p === "cancelled" || p === "canceled") return "cancelled";
  if (p === "past_due"  || p === "unpaid")   return "past_due";
  return "free";
}

// [LOOPS-PLAN] Whole days since signup, floored, never negative. Backs the
// numeric `daysIntoTrial` contact property the trial audience guard relies
// on. Recomputed every time a contact is synced (signup + daily cron) so it
// advances as days pass instead of freezing at the signup value. Returns
// undefined for an unparseable date so the caller omits the property rather
// than writing NaN/0.
export function computeDaysIntoTrial(signupAtIso) {
  const t = Date.parse(signupAtIso);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

// Fire a one-off event for a contact. Loops resolves the contact by
// userId or email, so callers should pass at least one. eventProperties
// are exposed in Loops's email template variables.
export async function sendLoopsEvent({ userId, email, eventName, properties }) {
  const key = loopsApiKey();
  if (!key) {
    console.warn("[loops] LOOPS_API_KEY not set; skipping event:", eventName);
    return { ok: false, note: "not configured" };
  }
  if (!eventName) return { ok: false, note: "eventName required" };
  if (!userId && !email) return { ok: false, note: "userId or email required" };
  try {
    const r = await fetch(LOOPS_API_BASE + "/events/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId:          userId || undefined,
        email:           email || undefined,
        eventName:       eventName,
        eventProperties: properties || {},
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.warn("[loops] event " + eventName + " returned " + r.status, text);
      return { ok: false, status: r.status };
    }
    return { ok: true };
  } catch (e) {
    console.error("[loops] event " + eventName + " threw:", e.message);
    return { ok: false, error: e.message };
  }
}

// Upsert contact properties so Loops can drive time-based segments
// (trial-ending, inactive-N-days, plan-state-aware copy). userId or
// email is required to identify the contact; everything else flows
// through to Loops as user properties.
export async function updateLoopsContact({ userId, email, properties }) {
  const key = loopsApiKey();
  if (!key) {
    console.warn("[loops] LOOPS_API_KEY not set; skipping contact update");
    return { ok: false, note: "not configured" };
  }
  if (!userId && !email) return { ok: false, note: "userId or email required" };
  try {
    const body = Object.assign({}, properties || {});
    if (userId) body.userId = userId;
    if (email)  body.email  = email;
    const r = await fetch(LOOPS_API_BASE + "/contacts/update", {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.warn("[loops] contact update returned " + r.status, text);
      return { ok: false, status: r.status };
    }
    return { ok: true };
  } catch (e) {
    console.error("[loops] contact update threw:", e.message);
    return { ok: false, error: e.message };
  }
}

// [LOOPS-DEDUPE] Audit finding #12. Fires a Loops event but only once per
// (userId, eventName, dedupeKey) tuple — protects against Cowork's Loops
// automations being configured WITHOUT per-contact event dedupe, which
// would otherwise let a duplicate fire (e.g. firstPlanGenerated on the
// 2nd plan if some flag got reset, subscriptionStarted on a Stripe-event
// re-process before idempotency landed, etc.) deliver a second copy of a
// one-shot email.
//
// Reuses the email_sends table with `template = "loops:<eventName>"` and
// the caller-supplied dedupeKey. PostgREST returns 409 on unique-conflict;
// claimSend returns false → we skip the actual Loops fire.
//
// When to use sendLoopsEventOnce vs plain sendLoopsEvent:
//   - sendLoopsEventOnce: events that must arrive AT MOST ONCE per user
//     (welcome, first-plan, founder-circle-full, subscriptionStarted,
//     thirtyDayMilestone, etc.)
//   - sendLoopsEvent: events that can fire multiple times by design
//     (per-plan-generated, per-caption-generated, repeated milestones)
//
// Fail-open: if claimSend errors (Supabase down), the event still fires
// — duplicate-risk is preferable to missed-event-on-infra-blip.
export async function sendLoopsEventOnce({ userId, email, eventName, properties, dedupeKey }) {
  if (!eventName) return { ok: false, note: "eventName required" };
  if (!userId)    return { ok: false, note: "userId required for dedupe" };
  if (!dedupeKey) return { ok: false, note: "dedupeKey required" };
  let claimed = true; // fail-open if claimSend throws
  try {
    claimed = await claimSend(userId, "loops:" + eventName, dedupeKey);
  } catch (e) {
    console.warn("[loops] claimSend threw, firing anyway:", e.message);
  }
  if (!claimed) {
    console.log("[loops] event " + eventName + " skipped — already fired for", dedupeKey);
    return { ok: true, deduped: true };
  }
  return sendLoopsEvent({ userId, email, eventName, properties });
}
