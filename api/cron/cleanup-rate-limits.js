// Nightly cleanup of public.rate_limit_events. The rate-limit RPC only
// looks at the trailing hour, so anything older than 24 hours is dead
// weight. Keeps the table from growing unbounded over months.
//
// Auth: same CRON_SECRET pattern as /api/cron/email-triggers — Vercel
// sends `Authorization: Bearer ${CRON_SECRET}` on scheduled invocations.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET          = process.env.CRON_SECRET;

export default async function handler(req, res) {
  const auth = req.headers.authorization || "";
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/rate_limit_events?created_at=lt.${encodeURIComponent(cutoff)}`,
      {
        method: "DELETE",
        headers: {
          apikey:        SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          Prefer:        "return=minimal",
        },
      }
    );
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("[cron/cleanup-rate-limits] supabase error", r.status, text);
      return res.status(500).json({ ok: false, error: text });
    }
    return res.status(200).json({ ok: true, cutoff });
  } catch (e) {
    console.error("[cron/cleanup-rate-limits] threw", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
