// User-facing rating endpoint. Auth-required, upserts a row in
// content_ratings keyed by (user_id, generation_type, target_ref).
// Sending the same rating twice is a no-op; sending the opposite rating
// flips it. Sending null clears the rating.
//
// POST body: {
//   generation_type: "plan_card" | "caption" | "scan_result" | "script",
//   target_ref:      string,            // stable per-user reference for the item
//   rating:          "up" | "down" | null
// }
//
// [PR0] A rating is a vote and nothing more. The one-tap reason chips
// that used to ride this endpoint were removed; the `reason` column from
// migration 025 stays nullable and is no longer written.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ALLOWED_TYPES   = new Set(["plan_card", "caption", "scan_result", "script"]);
const ALLOWED_RATINGS = new Set(["up", "down", null]);

// The unique constraint that identifies "this creator's rating of this item".
// Every upsert below has to name it explicitly — see the comment at the call
// site for why the default (the primary key) is the wrong target.
const RATING_CONFLICT_TARGET = "user_id,generation_type,target_ref";

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

    // Upsert the rating onto the existing row for this item, if any.
    //
    // `on_conflict` is NOT optional here. PostgREST defaults the ON CONFLICT
    // target to the PRIMARY KEY, and content_ratings' primary key is the
    // surrogate `id` — which we never send, so nothing ever conflicts on it.
    // The insert then goes on to violate the real key, UNIQUE (user_id,
    // generation_type, target_ref), and PostgREST returns 409. Without this
    // parameter the first rating on an item is the only write that ever
    // succeeds: every re-rate on that item 409s.
    // Naming the unique constraint's columns is what makes merge-duplicates
    // actually merge.
    const r = await fetch(`${SUPABASE_URL}/rest/v1/content_ratings?on_conflict=${RATING_CONFLICT_TARGET}`, {
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
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("[rate] upsert failed", r.status, text);
      return res.status(500).json({ error: "Could not save rating." });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[rate] threw", e.message);
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
