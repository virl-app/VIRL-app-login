// /api/founder-count.js
// ─────────────────────────────────────────────────────────────────────────────
// [PRICING 3] Public endpoint returning the current Founder Circle fill state.
//
// Used by:
//   - index.html upgrade modal (decides whether to show Founder Circle option)
//   - govirl.ai landing page live counter (read by the marketing site via CORS)
//
// Public — no auth required. The count is non-sensitive information that we
// want to surface widely as social proof / scarcity signal.
//
// Returns: { filled, remaining, isFull, cap }
// ─────────────────────────────────────────────────────────────────────────────

const FOUNDER_CIRCLE_CAP = 50;

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "public, max-age=15, s-maxage=15");
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    // Fail open as "available" — better to show the offer than hide it
    // because of an env config blip. Matches the philosophy in index.html.
    return res.status(200).json({
      filled: 0,
      remaining: FOUNDER_CIRCLE_CAP,
      isFull: false,
      cap: FOUNDER_CIRCLE_CAP,
    });
  }

  try {
    const r = await fetch(
      supabaseUrl + "/rest/v1/founding_positions?select=position&filled_at=not.is.null",
      {
        headers: {
          apikey: supabaseKey,
          Authorization: "Bearer " + supabaseKey,
          Prefer: "count=exact",
          "Range-Unit": "items",
          Range: "0-0",
        },
      }
    );
    const contentRange = r.headers.get("content-range");
    let filled = 0;
    if (contentRange) {
      const total = parseInt(contentRange.split("/")[1], 10);
      filled = isNaN(total) ? 0 : total;
    }
    const remaining = Math.max(0, FOUNDER_CIRCLE_CAP - filled);
    return res.status(200).json({
      filled: filled,
      remaining: remaining,
      isFull: filled >= FOUNDER_CIRCLE_CAP,
      cap: FOUNDER_CIRCLE_CAP,
    });
  } catch (e) {
    console.error("[founder-count] error:", e.message);
    return res.status(200).json({
      filled: 0,
      remaining: FOUNDER_CIRCLE_CAP,
      isFull: false,
      cap: FOUNDER_CIRCLE_CAP,
    });
  }
}
