// api/_lib/supabase-admin.js
// ─────────────────────────────────────────────────────────────────────────────
// Thin wrappers over the Supabase (GoTrue) Auth admin REST API, used by the
// Founder Circle payment-first flow (/welcome + stripe-webhook backfill).
//
// The rest of this codebase talks to Supabase over raw fetch rather than
// pulling in @supabase/supabase-js server-side (keeps the serverless bundle
// small), so these helpers follow the same pattern. Everything is fail-soft:
// callers get a structured result and decide what to do, rather than these
// throwing mid-request.
//
// Required env:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY   (service-role key — bypasses RLS, can mint links)
// ─────────────────────────────────────────────────────────────────────────────

function adminHeaders() {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  return {
    apikey: serviceKey,
    Authorization: "Bearer " + serviceKey,
    "Content-Type": "application/json",
  };
}

function authBase() {
  const url = process.env.SUPABASE_URL;
  return url ? url.replace(/\/+$/, "") + "/auth/v1" : null;
}

function configured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

// Create a new auth user. `email_confirm: true` so the address is treated as
// verified (the Stripe charge is our proof of email ownership). Returns a
// structured result so the caller can distinguish "created" from
// "already exists" without try/catch around an HTTP status.
//
// Result: { ok, status, user, exists, error }
//   exists === true  → an account with this email already exists (not an error
//                      for our flow — the caller upgrades it instead).
async function createUser({ email, password, userMetadata }) {
  if (!configured()) return { ok: false, error: "supabase_not_configured" };
  try {
    const res = await fetch(authBase() + "/admin/users", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        email: email,
        password: password,
        email_confirm: true,
        user_metadata: userMetadata || {},
      }),
    });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text }; }

    if (res.ok) {
      return { ok: true, status: res.status, user: body };
    }
    // GoTrue signals a duplicate email with 422 (error_code "email_exists") on
    // current versions, 409 on older ones. Match defensively on the message
    // too so a version bump doesn't silently break the upgrade path.
    const msg = (body && (body.msg || body.message || body.error_description || "")) + "";
    const code = (body && (body.error_code || body.code || "")) + "";
    const looksLikeExists =
      res.status === 422 ||
      res.status === 409 ||
      /email_exists/i.test(code) ||
      /already|registered|exists/i.test(msg);
    if (looksLikeExists) {
      return { ok: false, status: res.status, exists: true, error: "email_exists" };
    }
    console.error("[supabase-admin] createUser failed:", res.status, text);
    return { ok: false, status: res.status, error: "create_failed", body: body };
  } catch (e) {
    console.error("[supabase-admin] createUser threw:", e && e.message);
    return { ok: false, error: "create_threw" };
  }
}

// Merge-patch a user's user_metadata. GoTrue replaces the whole user_metadata
// object on update, so callers should pass an already-merged object (build it
// from the value read off generateMagicLink's response, which returns the
// user's current metadata). Returns { ok, user }.
async function updateUserMetadata(userId, userMetadata) {
  if (!configured() || !userId) return { ok: false, error: "supabase_not_configured" };
  try {
    const res = await fetch(authBase() + "/admin/users/" + encodeURIComponent(userId), {
      method: "PUT",
      headers: adminHeaders(),
      body: JSON.stringify({ user_metadata: userMetadata }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("[supabase-admin] updateUserMetadata failed:", res.status, text);
      return { ok: false, status: res.status, error: "update_failed" };
    }
    const user = await res.json().catch(() => ({}));
    return { ok: true, user: user };
  } catch (e) {
    console.error("[supabase-admin] updateUserMetadata threw:", e && e.message);
    return { ok: false, error: "update_threw" };
  }
}

// Mint a one-time magic link that logs the user in and lands them at
// `redirectTo`. Doubles as our reliable "look up an existing user by email"
// path: GoTrue's generate_link response carries the full user object
// (id + current user_metadata) alongside the action link, and there is no
// stable admin "get user by email" REST endpoint across versions.
//
// Result: { ok, actionLink, userId, userMetadata, raw }
async function generateMagicLink({ email, redirectTo }) {
  if (!configured()) return { ok: false, error: "supabase_not_configured" };
  try {
    const res = await fetch(authBase() + "/admin/generate_link", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        type: "magiclink",
        email: email,
        redirect_to: redirectTo,
      }),
    });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch (e) { body = {}; }
    if (!res.ok) {
      console.error("[supabase-admin] generateMagicLink failed:", res.status, text);
      return { ok: false, status: res.status, error: "generate_failed" };
    }
    // GoTrue flattens the link properties and the user object into one payload.
    // supabase-js would split these into { properties, user }; over raw REST we
    // read action_link from the top level and treat the rest as the user.
    const actionLink = body.action_link || (body.properties && body.properties.action_link) || null;
    const user = body.user || body;
    return {
      ok: !!actionLink,
      actionLink: actionLink,
      userId: user && user.id ? user.id : null,
      userMetadata: (user && user.user_metadata) || {},
      raw: body,
    };
  } catch (e) {
    console.error("[supabase-admin] generateMagicLink threw:", e && e.message);
    return { ok: false, error: "generate_threw" };
  }
}

export { createUser, updateUserMetadata, generateMagicLink, configured };
