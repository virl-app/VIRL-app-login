// [PREMIUM 7] Shared Loops API helpers. Both api/loops-event.js (auth-
// required, called by the browser) and any server-side caller (Stripe
// webhooks, cron jobs) route through these so we have one place
// handling the Loops bearer token, response shape, and graceful
// degradation. If LOOPS_API_KEY is unset, every helper logs and
// resolves with { ok: false, note: "not configured" } — never throws.

const LOOPS_API_BASE = "https://app.loops.so/api/v1";

function loopsApiKey() {
  return process.env.LOOPS_API_KEY || null;
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
