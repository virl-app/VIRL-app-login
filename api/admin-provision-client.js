// /api/admin-provision-client.js
// ─────────────────────────────────────────────────────────────────────────────
// [AGENCY-PROVISIONING] Server endpoint that creates a complete VIRL account
// for an agency-pilot client in a single round-trip — auth user + profile +
// comped credits row — so the agency owner (Jordan, for the v1 pilot) can
// onboard a new client practice in ~2 minutes instead of running through
// the normal signup + profile flow.
//
// Auth: admin-only. Same pattern as /api/admin-stats — verify the bearer
// token belongs to ADMIN_EMAIL via Supabase /auth/v1/user. Returning a
// fully-provisioned account is a high-trust operation; no non-admin caller
// should ever reach the body of this handler.
//
// Body shape:
//   {
//     email:    "jordan+brightsmile@nelsondental.co",   // login email
//     password: "...",                                    // temp / shared
//     intake: {
//       name:           "Bright Smile Dental",
//       audience:       "...",
//       voice:          "...",
//       sampleCaption:  "...",
//       voiceSamples:   ["...","..."],
//       myPlatforms:    ["Instagram", "TikTok"],
//       vibes:          ["...","..."],
//       topics:         "...",
//       purpose:        "...",
//       offLimits:      "...",
//       inspiration:    "...",
//       pillars:        ["...","..."],
//       emojiPref:      "Sometimes",
//       handles:        { instagram: "...", tiktok: "..." },
//       platformAudiences: { Instagram: "..." },
//       platformFormats:   { Instagram: ["Reels","Carousels"] },
//       postFreq:       "A few times a week",
//       contentLength:  "Medium",
//       workedWell:     "...",
//       niche:          "Dentistry",   // optional — sets compliance bucket
//       // [LEARN-CONSENT] All four learning toggles default ON for agency
//       // clients since the agency owner is the operator + has accepted
//       // the consent posture on the client's behalf as part of the pilot
//       // agreement. Override individually in `intake` if a specific
//       // client wants any of them OFF.
//       learnFromEdits:        true,
//       learnFromVault:        true,
//       learnFromResults:      true,
//       learnFromPublicPosts:  true
//     },
//     compWeeks:  52     // optional — defaults to 52 (one year)
//     compWeekly: 150    // optional — defaults to 150 credits/week
//   }
//
// Response:
//   200 { user_id, login_email, login_url }
//   400 { error: 'validation message' }
//   401 { error }                                       — invalid / missing token
//   403 { error }                                       — non-admin caller
//   409 { error: 'user already exists', existing_user_id }
//   500 { error }                                       — server config / DB
//
// Idempotency: re-running with the same email returns 409 + existing_user_id
// rather than creating a duplicate. Lauren can then PATCH the profile via the
// normal app flow if she needs to update anything.
//
// Comp: the credits row is created with comp_weekly_credits + comp_expires_at
// populated (migration 012's mechanism), so the lazy weekly reset in chat.js
// keeps refilling the allowance at the configured rate until comp_expires_at
// passes. No Stripe customer, no founding tier — agency clients are billed
// through the agency owner's master invoice, not per-seat.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_EMAIL          = "laurenannedoty@gmail.com";

// Defaults tuned to "one-year pilot at the Pro weekly allowance" so the
// account doesn't run out of credits mid-pilot and Lauren doesn't have
// to remember to re-comp every week. comp_expires_at extends past any
// reasonable pilot horizon; agency clients that churn out get their
// comp_weekly_credits manually nulled to revert to free-tier behavior.
const DEFAULT_COMP_WEEKS  = 52;
const DEFAULT_COMP_WEEKLY = 150;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 12;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  // ── Auth: admin only ─────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ error: "Missing auth token" });
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: "Bearer " + token, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Invalid token" });
    const u = await userRes.json();
    if (!u || !u.email || u.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
      return res.status(403).json({ error: "Not authorized" });
    }
  } catch (e) {
    return res.status(401).json({ error: "Token verification failed" });
  }

  // ── Body validation ──────────────────────────────────────────────────────
  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const email     = typeof body.email    === "string" ? body.email.trim().toLowerCase() : "";
  const password  = typeof body.password === "string" ? body.password : "";
  const intake    = (body.intake && typeof body.intake === "object") ? body.intake : {};
  const compWeeks  = (typeof body.compWeeks  === "number" && body.compWeeks  > 0) ? body.compWeeks  : DEFAULT_COMP_WEEKS;
  const compWeekly = (typeof body.compWeekly === "number" && body.compWeekly > 0) ? body.compWeekly : DEFAULT_COMP_WEEKLY;

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Invalid email." });
  if (password.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` });
  }
  if (!intake.name || typeof intake.name !== "string" || !intake.name.trim()) {
    return res.status(400).json({ error: "intake.name is required (use the client's practice / brand name)." });
  }

  // ── 1. Create the auth user ──────────────────────────────────────────────
  // email_confirm: true skips the confirmation-email flow — Lauren has
  // confirmed the email out-of-band as part of provisioning, and an agency
  // client signing in with the master password shouldn't have to click a
  // verification link first.
  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method:  "POST",
    headers: {
      apikey:         SUPABASE_SERVICE_KEY,
      Authorization:  "Bearer " + SUPABASE_SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      // Carry provenance metadata so a later "who provisioned this account"
      // query has an answer. Doesn't affect auth or RLS — purely audit.
      user_metadata: {
        agency_pilot:      true,
        provisioned_by:    ADMIN_EMAIL,
        provisioned_at:    new Date().toISOString(),
        client_label:      intake.name.trim(),
      },
    }),
  });

  // Detect "user already exists" so the caller gets a clean idempotent
  // response with the existing user id rather than a generic 500.
  if (!createRes.ok) {
    const errBody = await createRes.text().catch(() => "");
    let parsed = null;
    try { parsed = JSON.parse(errBody); } catch (e) {}
    const isDuplicate = createRes.status === 422
      || (parsed && /already.*registered|already.*exists|duplicate/i.test(parsed.msg || parsed.message || ""));
    if (isDuplicate) {
      // Look up the existing user so the response is useful.
      try {
        const lookup = await fetch(
          `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
          {
            headers: {
              apikey:        SUPABASE_SERVICE_KEY,
              Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
            },
          }
        );
        if (lookup.ok) {
          const lookupBody = await lookup.json();
          const existing = (lookupBody && Array.isArray(lookupBody.users) && lookupBody.users[0]) || null;
          if (existing && existing.id) {
            return res.status(409).json({
              error:            "User already exists.",
              existing_user_id: existing.id,
            });
          }
        }
      } catch (e) { /* fall through to generic 409 */ }
      return res.status(409).json({ error: "User already exists." });
    }
    console.error("[admin-provision-client] auth create failed:", createRes.status, parsed || errBody);
    return res.status(500).json({
      error: "Auth user creation failed: " + ((parsed && (parsed.msg || parsed.message)) || createRes.status),
    });
  }

  const authUser = await createRes.json();
  const newUserId = authUser && authUser.id;
  if (!newUserId) {
    return res.status(500).json({ error: "Auth response missing user id." });
  }

  // ── 2. Insert the profile row ────────────────────────────────────────────
  // Mirrors the column set in saveProfileToSupabase (index.html) so the app
  // hydrates with the intake values exactly as if the client had typed
  // them in the Profile tab. Missing fields fall through to nulls / empty
  // collections, same as a fresh signup who hasn't filled a field yet.
  const profileRow = {
    id:                 newUserId,
    name:               intake.name || null,
    audience:           intake.audience || null,
    voice:              intake.voice || null,
    my_platforms:       Array.isArray(intake.myPlatforms) ? intake.myPlatforms : [],
    vibes:              Array.isArray(intake.vibes) ? intake.vibes : [],
    sample_caption:     intake.sampleCaption || null,
    voice_samples:      Array.isArray(intake.voiceSamples)
                          ? intake.voiceSamples.map(s => String(s || "").trim()).filter(Boolean)
                          : [],
    topics:             intake.topics || null,
    purpose:            intake.purpose || null,
    off_limits:         intake.offLimits || null,
    inspiration:        intake.inspiration || null,
    journey:            intake.journey || null,
    known_for:          intake.knownFor || null,
    pillars:            Array.isArray(intake.pillars) ? intake.pillars : [],
    emoji_pref:         intake.emojiPref || "Sometimes",
    handles:            (intake.handles && typeof intake.handles === "object") ? intake.handles : {},
    platform_audiences: (intake.platformAudiences && typeof intake.platformAudiences === "object") ? intake.platformAudiences : {},
    platform_formats:   (intake.platformFormats && typeof intake.platformFormats === "object") ? intake.platformFormats : {},
    post_freq:          intake.postFreq || null,
    content_length:     intake.contentLength || null,
    worked_well:        intake.workedWell || null,
    personal_facts:     intake.personalFacts || null,
    never_assume:       intake.neverAssume || null,
    love_to_reference:  intake.loveToReference || null,
    // [LEARNING-CONSENT] Default ALL learning toggles ON for agency
    // clients — the operator (Jordan) has accepted on the client's
    // behalf as part of the pilot agreement. Each can be overridden
    // per-client via the intake body.
    learn_from_edits:        intake.learnFromEdits        !== false,
    learn_from_vault:        intake.learnFromVault        !== false,
    learn_from_results:      intake.learnFromResults      !== false,
    learn_from_public_posts: intake.learnFromPublicPosts  !== false,
  };

  const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
    method:  "POST",
    headers: {
      apikey:         SUPABASE_SERVICE_KEY,
      Authorization:  "Bearer " + SUPABASE_SERVICE_KEY,
      "Content-Type": "application/json",
      Prefer:         "resolution=merge-duplicates",
    },
    body: JSON.stringify(profileRow),
  });
  if (!profileRes.ok) {
    const t = await profileRes.text().catch(() => "");
    console.error("[admin-provision-client] profile insert failed:", profileRes.status, t);
    // The auth user was created — don't roll that back; just report so
    // Lauren can manually patch the profile from the app if needed.
    return res.status(500).json({
      error:    "Profile insert failed (auth user was still created).",
      user_id:  newUserId,
      detail:   t.slice(0, 300),
    });
  }

  // ── 3. Insert the credits row with comp settings ─────────────────────────
  // Reuses migration 012's tester-comp mechanism: comp_weekly_credits +
  // comp_expires_at make the lazy weekly reset in api/chat.js refill
  // the allowance at the configured rate until the expiry date passes.
  // No Stripe customer, no founding tier — agency clients bill through
  // the agency owner's master invoice, not per-seat.
  const now = new Date();
  const compExpires = new Date(now.getTime() + compWeeks * 7 * 24 * 60 * 60 * 1000);
  const resetAt     = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const creditsRow = {
    user_id:             newUserId,
    plan:                "agency_pilot",
    credits:             compWeekly,
    reset_at:            resetAt.toISOString(),
    comp_weekly_credits: compWeekly,
    comp_expires_at:     compExpires.toISOString(),
  };
  const creditsRes = await fetch(`${SUPABASE_URL}/rest/v1/credits`, {
    method:  "POST",
    headers: {
      apikey:         SUPABASE_SERVICE_KEY,
      Authorization:  "Bearer " + SUPABASE_SERVICE_KEY,
      "Content-Type": "application/json",
      Prefer:         "resolution=merge-duplicates",
    },
    body: JSON.stringify(creditsRow),
  });
  if (!creditsRes.ok) {
    const t = await creditsRes.text().catch(() => "");
    console.error("[admin-provision-client] credits insert failed:", creditsRes.status, t);
    return res.status(500).json({
      error:   "Credits insert failed (auth + profile already created).",
      user_id: newUserId,
      detail:  t.slice(0, 300),
    });
  }

  // ── 4. Done ──────────────────────────────────────────────────────────────
  return res.status(200).json({
    user_id:     newUserId,
    login_email: email,
    login_url:   "https://app.govirl.ai/",
    comp: {
      weekly_credits: compWeekly,
      expires_at:     compExpires.toISOString(),
    },
  });
}
