// Public client-config endpoint. Surfaces only the env-var values that the
// browser legitimately needs at runtime (e.g. founder Calendly URL for the
// feedback widget). Everything sensitive stays server-side.
//
// No auth — these values are public-by-design. Only add fields here that
// are safe to expose to anyone hitting the page.

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  // Browsers cache aggressively; we want the config to refresh promptly when
  // an env var changes (e.g. Calendly URL added without a redeploy).
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    founder_calendly_url: process.env.FOUNDER_CALENDLY_URL || null,
  });
}
