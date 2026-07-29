// User-facing rating endpoint. Auth-required, upserts a row in
// content_ratings keyed by (user_id, generation_type, target_ref).
// Sending the same rating twice is a no-op; sending the opposite rating
// flips it. Sending null clears the rating.
//
// POST body: {
//   generation_type: "plan_card" | "caption" | "scan_result" | "script",
//   target_ref:      string,            // stable per-user reference for the item
//   rating:          "up" | "down" | null,
//   reason:          "Too formal" | "Not my words" | "Wrong energy" | null
// }
//
// [REACTION-LOOP] `reason` is the one-tap chip the client shows after a
// thumbs-down. It used to POST to /api/feedback — the support inbox —
// where nothing ever read it back, while the UI promised "Noted — I'll
// learn from this." It now lands on the rating row it describes, and
// api/_lib/voice-reactions.js feeds it into the creator's next
// generations, which is what the chip always claimed to do.
//
// The vocabulary is a CLOSED SET owned by this file. That's deliberate:
// these strings end up inside a prompt, and a closed set is what makes
// them aggregatable ("flagged too formal 3 times") and safe to inject.
// Free-text belongs in /api/feedback, which is still the right home for
// prose the team reads.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ALLOWED_TYPES   = new Set(["plan_card", "caption", "scan_result", "script"]);
const ALLOWED_RATINGS = new Set(["up", "down", null]);
const ALLOWED_REASONS = new Set(["Too formal", "Not my words", "Wrong energy"]);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }

  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!auth) return res.status(401).json({ error: "Sign in required." });

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

  const body = req.body || {};
  const generationType = body.generation_type;
  const targetRef      = body.target_ref;
  const rating         = body.rating === undefined ? null : body.rating;

  if (!ALLOWED_TYPES.has(generationType)) return res.status(400).json({ error: "Invalid generation_type" });
  if (!targetRef || typeof targetRef !== "string") return res.status(400).json({ error: "target_ref required" });
  if (!ALLOWED_RATINGS.has(rating)) return res.status(400).json({ error: "rating must be 'up', 'down', or null" });

  // An unrecognized reason is rejected outright rather than quietly
  // stored as NULL. Silently dropping it is exactly the bug this change
  // exists to fix: the old chip sent sentiment:"negative" to an endpoint
  // whose allowed set is {happy, neutral, sad}, so every chip tap was
  // written with a null sentiment and nobody found out.
  const rawReason = body.reason;
  if (rawReason !== undefined && rawReason !== null && !ALLOWED_REASONS.has(rawReason)) {
    return res.status(400).json({ error: "Unrecognized reason." });
  }
  const reason = ALLOWED_REASONS.has(rawReason) ? rawReason : null;
  // A reason only means something attached to a thumbs-down — it is the
  // answer to "what was wrong with this one".
  if (reason && rating !== "down") {
    return res.status(400).json({ error: "A reason requires a thumbs-down rating." });
  }

  try {
    if (rating === null) {
      // Clear: delete the row if it exists.
      await fetch(
        `${SUPABASE_URL}/rest/v1/content_ratings?user_id=eq.${user.id}&generation_type=eq.${encodeURIComponent(generationType)}&target_ref=eq.${encodeURIComponent(targetRef)}`,
        {
          method: "DELETE",
          headers: {
            apikey:        SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            Prefer:        "return=minimal",
          },
        }
      );
      return res.status(200).json({ ok: true });
    }

    // Upsert the rating. Unique constraint on (user_id, generation_type,
    // target_ref) means re-rates flip the existing row.
    const r = await fetch(`${SUPABASE_URL}/rest/v1/content_ratings`, {
      method: "POST",
      headers: {
        apikey:        SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer:        "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        user_id:         user.id,
        generation_type: generationType,
        target_ref:      targetRef,
        rating:          rating,
        // [REACTION-LOOP] Only written when a chip came with this call.
        // Flipping down→up→down without tapping a chip shouldn't
        // resurrect a stale reason, and merge-duplicates would keep the
        // old value if we omitted the key — so send an explicit null.
        reason:          reason,
        reason_at:       reason ? new Date().toISOString() : null,
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("[rate] upsert failed", r.status, text);
      // A reason write against a database that hasn't run migration 025
      // yet fails on the unknown column. Retry once without those two
      // fields so the rating itself still lands — the creator's thumbs
      // -down is worth more than the annotation on it.
      if (reason) {
        const retry = await fetch(`${SUPABASE_URL}/rest/v1/content_ratings`, {
          method: "POST",
          headers: {
            apikey:        SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            "Content-Type": "application/json",
            Prefer:        "resolution=merge-duplicates,return=minimal",
          },
          body: JSON.stringify({
            user_id:         user.id,
            generation_type: generationType,
            target_ref:      targetRef,
            rating:          rating,
          }),
        });
        if (retry.ok) return res.status(200).json({ ok: true, reasonStored: false });
      }
      return res.status(500).json({ error: "Could not save rating." });
    }
    return res.status(200).json({ ok: true, reasonStored: !!reason });
  } catch (e) {
    console.error("[rate] threw", e.message);
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
