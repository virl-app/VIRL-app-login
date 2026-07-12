// /api/plan-status.js
// ─────────────────────────────────────────────────────────────────────────────
// [PLAN-JOB-RECOVERY] Read-side of the streaming plan recovery flow.
//
// When the client's SSE connection drops mid-stream (the dominant mobile
// failure: tab backgrounded, screen locked, network hiccup), the server's
// Anthropic call usually finishes anyway and the result is persisted to
// plan_jobs. The client polls this endpoint to discover that the job
// completed and hydrates from `result_text` exactly as if it had streamed
// in normally.
//
// Auth: bearer token verified against Supabase. The user_id comes from
// the verified token; the plan_jobs query is constrained to that user so
// a leaked job id can never expose another user's generation.
//
// Returns:
//   200 { status: "running" }                      – job still in flight
//   200 { status: "complete", result_text, cost,
//         usage, trends_snapshot, used_fresh_trends } – job finished
//   200 { status: "error", error_msg }             – job failed upstream
//   404 { status: "missing" }                      – no row for this id
//                                                    (id was never persisted
//                                                    or never belonged to
//                                                    this user)
//   401 { error }                                  – invalid / missing token
//   500 { error }                                  – server config issue
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Same UUID validator as the writer in chat.js. Server-side guard against
// a client passing a goofy id and triggering a PostgREST parse error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const id = (req.query && req.query.id) ? String(req.query.id) : "";
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id." });
  }

  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Sign in required." });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }

  // Resolve the requesting user from the bearer token. NEVER trust a
  // user_id supplied in the body or query – same rule that applies to
  // every endpoint that reaches Supabase via the service key.
  let userId;
  try {
    const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Sign in required." });
    const u = await userRes.json();
    userId = u && u.id;
    if (!userId) return res.status(401).json({ error: "Sign in required." });
  } catch (e) {
    return res.status(401).json({ error: "Sign in required." });
  }

  try {
    // Query by (id, user_id) so a leaked id can't return another user's
    // row even via the service-key path.
    const r = await fetch(
      SUPABASE_URL + "/rest/v1/plan_jobs?id=eq." + encodeURIComponent(id)
        + "&user_id=eq." + encodeURIComponent(userId)
        + "&select=status,result_text,error_msg,cost,usage,trends_snapshot,used_fresh_trends"
        + "&limit=1",
      {
        headers: {
          apikey:        SUPABASE_SERVICE_KEY,
          Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
        },
      }
    );
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("[plan-status] fetch failed:", r.status, text);
      return res.status(500).json({ error: "Could not load job." });
    }
    const rows = await r.json();
    const row  = (Array.isArray(rows) && rows.length > 0) ? rows[0] : null;
    if (!row) {
      // 404 vs 200 { status: "missing" }: returning 404 lets the client
      // distinguish "row truly doesn't exist" from "server returned an
      // empty payload for some other reason." Important for the polling
      // loop's termination conditions.
      return res.status(404).json({ status: "missing" });
    }
    if (row.status === "running") {
      return res.status(200).json({ status: "running" });
    }
    if (row.status === "error") {
      return res.status(200).json({
        status:     "error",
        error_msg:  row.error_msg || null,
      });
    }
    return res.status(200).json({
      status:            "complete",
      result_text:       row.result_text,
      cost:              row.cost,
      usage:             row.usage,
      trends_snapshot:   row.trends_snapshot,
      used_fresh_trends: row.used_fresh_trends,
    });
  } catch (e) {
    console.error("[plan-status] threw:", e.message);
    return res.status(500).json({ error: "Could not load job." });
  }
}
