// Shared auth gate for the Vercel cron endpoints (api/cron/*). Vercel
// injects `Authorization: Bearer ${CRON_SECRET}` on scheduled invocations
// IFF a CRON_SECRET env var is set for the environment; if it's absent
// Vercel sends no auth header at all and every scheduled run 401s.
//
// Why this exists: the four crons each had an identical inline guard that
// returned 401 with NO log line, so a missing/stale CRON_SECRET in
// Production failed silently – the daily email + Loops-property sync (and
// the cleanup/playbook/trends jobs) just stopped, invisible until someone
// correlated the schedule against runtime logs. This helper centralizes the
// check and logs WHY a request was rejected (missing secret vs. bearer
// mismatch) so the failure is diagnosable at a glance. It never prints the
// secret itself.
//
// Behavior is unchanged from the old inline guard: returns true only when
// the bearer matches CRON_SECRET. Callers still send the 401 themselves so
// the response shape stays visible at the call site.
export function cronAuthorized(req, label) {
  const secret = process.env.CRON_SECRET;
  const auth = (req && req.headers && req.headers.authorization) || "";
  if (!secret) {
    console.warn(`[cron-auth] ${label}: rejected – CRON_SECRET is not set in this environment`);
    return false;
  }
  if (auth !== `Bearer ${secret}`) {
    console.warn(`[cron-auth] ${label}: rejected – Authorization header ${auth ? "did not match CRON_SECRET" : "was missing"}`);
    return false;
  }
  return true;
}
