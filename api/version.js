// [UPDATE-NUDGE] Deployment identity endpoint. The SPA baselines this
// sha at load and re-checks on tab focus / every 30 min; a mismatch
// means a newer production deploy exists and the client shows a
// refresh nudge. There is no service worker, so this is the only
// signal a long-lived tab or iOS home-screen session ever gets that
// its bundle is stale (root cause of the lingering credits-400 clients).
//
// VERCEL_GIT_COMMIT_SHA is injected by Vercel at build time. Fallback
// to VERCEL_DEPLOYMENT_ID-ish env or null (client treats null as
// "cannot determine, never nudge").
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const sha =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.VERCEL_URL || // unique per deployment; stable fallback
    null;
  return res.status(200).json({ sha });
}
