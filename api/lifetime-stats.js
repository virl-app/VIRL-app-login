// [SEED-COUNTERS] Returns the authenticated user's lifetime generation
// counts so the client can seed its localStorage milestone counters from
// server truth on session mount, rather than treating "no localStorage
// key" as "this user is brand new."
//
// Why this exists:
//   The client tracks first-plan / first-caption / first-scan celebration
//   overlays + milestone modals via localStorage flags
//   (virl_plans_completed, virl_first_plan_celebrated, etc). When a user
//   signs out, clearLocalUserData() wipes every virl_* key — so the next
//   sign-in on the same browser, or any sign-in from a fresh browser
//   (incognito, different device, new install), starts with all flags
//   unset. The next plan generation then increments the counter from 0
//   to 1 and fires the "first plan!" celebration for a user who's been
//   around for months.
//
//   This endpoint lets the client backfill the counters with the server's
//   actual generation history so returning users skip the celebrations
//   correctly.
//
// Source of truth: public.usage_events. Each successful generation
// (plan, caption, scan_image, scan_video_frame) inserts a row there via
// api/chat.js → recordUsageEvent. We aggregate per generation type and
// return the lifetime totals.
//
// Auth: bearer token, identical pattern to /api/email/welcome and
// /api/loops-event. Only ever returns counts for the authenticated user.
//
// Fail-open: returns 200 with zeros on any infra error so the client's
// fire-and-forget never breaks — worst case the user sees a stale
// celebration once, which beats blocking the app on a Supabase blip.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// usage_events.generation_type values that contribute to each client-side
// counter. Scan has two underlying types (image + video frame) because
// the prompt builders distinguish them, but for celebration purposes the
// client only cares about "any scan."
const PLAN_TYPES    = new Set(["plan"]);
const CAPTION_TYPES = new Set(["caption", "caption_remix"]);
const SCAN_TYPES    = new Set(["scan_image", "scan_video_frame"]);

async function fetchCounts(userId) {
  const out = { planCount: 0, captionCount: 0, scanCount: 0 };
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !userId) return out;
  try {
    // PostgREST aggregate via the count header — keeps the response
    // tiny (one HEAD-like exchange per type) instead of pulling rows.
    // We could combine all three into a single grouped query, but
    // PostgREST doesn't expose GROUP BY cleanly without an RPC; three
    // bounded counts is simpler to reason about and trivially fast on
    // the indexed (user_id, generation_type) columns.
    async function countForTypes(typeSet) {
      const types = Array.from(typeSet);
      const inClause = types.map(t => '"' + t + '"').join(",");
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/usage_events`
        + `?user_id=eq.${userId}`
        + `&generation_type=in.(${inClause})`
        + `&select=user_id`,
        {
          headers: {
            apikey:           SUPABASE_SERVICE_KEY,
            Authorization:    `Bearer ${SUPABASE_SERVICE_KEY}`,
            Prefer:           "count=exact",
            // HEAD would be ideal here but PostgREST's exact-count header
            // is set on GET responses too. Body is ignored.
            Range:            "0-0",
          },
        }
      );
      if (!res.ok) return 0;
      const contentRange = res.headers.get("content-range") || "";
      const total = parseInt(contentRange.split("/")[1] || "0", 10);
      return Number.isFinite(total) ? total : 0;
    }
    const [planCount, captionCount, scanCount] = await Promise.all([
      countForTypes(PLAN_TYPES),
      countForTypes(CAPTION_TYPES),
      countForTypes(SCAN_TYPES),
    ]);
    out.planCount    = planCount;
    out.captionCount = captionCount;
    out.scanCount    = scanCount;
  } catch (e) { /* fail-open with zeros */ }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Sign in required." });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }

  // Verify the token + resolve userId. The endpoint NEVER trusts
  // a user_id from the request body — the only counts ever returned
  // are for the authenticated caller.
  let userId;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!r.ok) return res.status(401).json({ error: "Sign in required." });
    const u = await r.json();
    userId = u.id;
  } catch (e) {
    return res.status(401).json({ error: "Sign in required." });
  }
  if (!userId) return res.status(401).json({ error: "Sign in required." });

  const counts = await fetchCounts(userId);
  return res.status(200).json(counts);
}
