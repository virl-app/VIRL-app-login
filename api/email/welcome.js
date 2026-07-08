// Inline welcome email. Fired by the client on first SIGNED_IN. Idempotent
// thanks to either Resend's email_sends unique constraint (legacy path) OR
// Loops's per-contact event dedupe (new path) — a second call from a token
// refresh, a different tab, or the cron safety-net is a no-op.
//
// [EMAIL-CUTOVER] Two responsibilities now:
//
//   1. Always-on: sync core contact properties to Loops (firstName,
//      lastName, signupAt, marketingSubscribed). These flow from the
//      atomic supabaseClient.auth.signUp user_metadata write to Loops
//      so downstream audience filters (trial-day-N from signupAt, the
//      monthly editorial / re-engagement suppression checks) have the
//      data they need.
//
//   2. Feature-flagged: WHICH service sends the welcome email.
//      EMAIL_VIA_LOOPS=true  → fire `signup_welcome` Loops event;
//                              Cowork's Loops automation owns the send.
//      EMAIL_VIA_LOOPS unset → original Resend `welcome` template send.
//
//      Flip the env var in Vercel once Cowork's Loops are enabled and
//      verified. No-double-send guarantee: only one of the two paths
//      fires per request based on the flag.

import { sendEmail, emailEnabled, claimSend }   from "../_lib/email-send.js";
import { welcome as welcomeTemplate }           from "../_lib/email-templates.js";
import { sendLoopsEvent, updateLoopsContact, loopsPlanValue, computeDaysIntoTrial } from "../_lib/loops.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const EMAIL_VIA_LOOPS      = process.env.EMAIL_VIA_LOOPS === "true";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Sign in required." });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }

  // Verify the bearer token against Supabase auth — same pattern as chat.js.
  let user;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Sign in required." });
    user = await userRes.json();
  } catch (e) {
    return res.status(401).json({ error: "Sign in required." });
  }

  // Pull display name from profile if present (best-effort, non-fatal).
  let firstName = "";
  let lastName  = "";
  try {
    const profRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=name`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (profRes.ok) {
      const rows = await profRes.json();
      // Strip < > — name is user-controlled and lands raw in HTML email bodies.
      if (rows[0] && rows[0].name) firstName = String(rows[0].name).replace(/[<>]/g, "").slice(0, 120);
    }
  } catch (e) { /* non-fatal */ }

  // [EMAIL-CUTOVER] Pull first/last name + marketing opt-in from the
  // user_metadata that supabaseClient.auth.signUp wrote atomically. The
  // email_preferences row is fire-and-forget on the client and may not
  // have landed yet when this endpoint fires on first SIGNED_IN; reading
  // user_metadata avoids that race for the initial Loops sync.
  const meta = (user && user.user_metadata) || {};
  if (!firstName && typeof meta.first_name === "string") firstName = meta.first_name;
  if (typeof meta.last_name === "string") lastName = meta.last_name;
  const marketingSubscribed = !!meta.marketing_opt_in;

  // [LOOPS-PLAN] Derive the contact's plan from the credits row so the Loops
  // `plan` property is set on the very first sync instead of arriving blank.
  // A brand-new signup usually has no credits row yet (lazy-provisioned) →
  // null → loopsPlanValue() maps it to "free". The rare user who paid before
  // this inline welcome fires keeps their real paid tier. Best-effort: a
  // read failure falls through to "free" rather than blocking the sync.
  let supabasePlan = null;
  try {
    const credRes = await fetch(
      `${SUPABASE_URL}/rest/v1/credits?user_id=eq.${user.id}&select=plan`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (credRes.ok) {
      const rows = await credRes.json();
      if (rows[0] && rows[0].plan != null) supabasePlan = rows[0].plan;
    }
  } catch (e) { /* non-fatal — defaults to "free" */ }
  const signupAt = user.created_at || new Date().toISOString();

  // [EMAIL-CUTOVER] Always-on: sync contact properties to Loops. This is
  // §9 audit fix #4 — Loops's contact data now mirrors the Supabase
  // source of truth, so audience filters can suppress marketing sends to
  // opted-out users and use signupAt for trial-day-N targeting.
  // Fire-and-forget — Loops downtime never blocks the welcome flow.
  updateLoopsContact({
    userId: user.id,
    email:  user.email,
    properties: {
      firstName:           firstName || undefined,
      lastName:            lastName  || undefined,
      signupAt:            signupAt,
      marketingSubscribed,
      // [LOOPS-PLAN] Never blank: free/trial → "free", paid → real tier.
      // daysIntoTrial seeds the trial audience guard at 0 on signup day;
      // the daily cron sync advances it as days pass.
      plan:                loopsPlanValue(supabasePlan),
      daysIntoTrial:       computeDaysIntoTrial(signupAt),
    },
  }).catch(() => {});

  // Welcome send dispatcher.
  if (EMAIL_VIA_LOOPS) {
    // [EMAIL-CUTOVER] Loops path. The `signup_welcome` Loops automation
    // (built by Claude Cowork, enabled separately) owns the actual send.
    //
    // [CROSS-PATH-DEDUPE] The cron safety-net in api/cron/email-triggers.js
    // fires the Resend `welcome` template UNCONDITIONALLY for days <= 7
    // (comment there claims email_sends dedupe covers the Loops happy path,
    // but that only holds if the inline Loops call claimed the shared
    // (template=welcome, dedupe_key=welcome) slot — sendLoopsEvent alone
    // does not). Pre-claim that slot here so the cron sees the inline
    // Loops send and skips its Resend copy; a Loops-side failure still
    // leaves the row in place (documented Loops failures don't retry via
    // Resend), which matches every other inline→cron pair in the codebase.
    const claimed = await claimSend(user.id, "welcome", "welcome");
    if (!claimed) {
      return res.status(200).json({ sent: false, deduped: true, via: "loops" });
    }
    const out = await sendLoopsEvent({
      userId:    user.id,
      email:     user.email,
      eventName: "signup_welcome",
      properties: { firstName: firstName || "", marketingSubscribed },
    });
    return res.status(200).json({ sent: out.ok === true, via: "loops" });
  }

  // Legacy Resend path. Active until EMAIL_VIA_LOOPS=true is set in Vercel.
  if (!emailEnabled()) {
    return res.status(200).json({ sent: false, reason: "email_disabled" });
  }
  const tpl = welcomeTemplate({ name: firstName });
  const sent = await sendEmail({
    userId:    user.id,
    to:        user.email,
    template:  "welcome",
    dedupeKey: "welcome",
    subject:   tpl.subject,
    html:      tpl.html,
    text:      tpl.text,
    marketing: false, // welcome is transactional
  });

  return res.status(200).json({ sent, via: "resend" });
}
