// scripts/check-trend-health-alert.mjs
//
// [A3] Runs the real api/cron/trend-health.js handler against simulated
// Supabase data (fetch is stubbed; no network, no email) and asserts on
// whether it TRIES to email. "Tries" = claims an email_sends row, which
// sendEmail does before every send; the stub refuses the claim, so nothing
// goes out even if Resend were configured.
//
// Scenarios, each a pair in the house style (alarm fires / alarm quiet):
//   1. Production as of 2026-11-21: trend_items last written 2026-07-30
//      (observed tier dormant), weekly research written today on every
//      platform and segment. Must NOT email. Before A3 this emailed daily.
//   2. Same, but the weekly research is 11 days old everywhere. MUST email.
//   3. Weekly research 15 days old and segment tier empty: every platform
//      dark. MUST email, and must say so (bothDark).
//   4. One platform lagging past 10 days, the rest fresh. MUST email.

const DAY = 86400000;
const NOW = Date.now();
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

process.env.SUPABASE_URL = "https://sim.supabase.local";
process.env.SUPABASE_SERVICE_KEY = "sim-service-key";
process.env.CRON_SECRET = "sim-cron-secret";
process.env.RESEND_API_KEY = "re_sim";

const PLATFORMS = ["TikTok", "Instagram", "Facebook", "YouTube", "LinkedIn", "X", "Pinterest"];
const { SEGMENT_PLATFORMS } = await import("../api/cron/trends-refresh.js");
const item = [{ trend: "Simulated trend", why: "x" }];

function scenario({ observedDaysAgo, legacyDaysAgo, segmentDaysAgo, segmentItems = true, perPlatformLegacy = {} }) {
  const legacy = PLATFORMS.map(p => ({ platform: p, fetched_at: iso(perPlatformLegacy[p] ?? legacyDaysAgo) }));
  const segments = [];
  for (const [seg, plats] of Object.entries(SEGMENT_PLATFORMS)) {
    for (const p of plats) segments.push({ segment: seg, platform: p, items: segmentItems ? item : [], fetched_at: iso(segmentDaysAgo) });
  }
  return { observed: [{ last_seen: iso(observedDaysAgo) }], legacy, segments };
}

async function run(data) {
  let claims = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.includes("/auth/v1/admin/users")) return json({ users: [{ id: "00000000-0000-4000-8000-000000000001", email: "laurenannedoty@gmail.com" }] });
    if (u.includes("/rest/v1/trend_items")) return json(data.observed);
    if (u.includes("/rest/v1/trends") && u.includes("segment=not.is.null")) {
      const since = Date.parse(decodeURIComponent((u.match(/fetched_at=gte\.([^&]+)/) || [])[1] || "1970"));
      return json(data.segments.filter(r => Date.parse(r.fetched_at) >= since));
    }
    if (u.includes("/rest/v1/trends")) return json(data.legacy);
    if (u.includes("/rest/v1/email_sends")) { if ((init && init.method) === "POST") claims++; return json({ message: "duplicate" }, 409); }
    throw new Error("unexpected fetch in simulation: " + u);
  };
  const { default: handler } = await import("../api/cron/trend-health.js");
  let out = null;
  const res = { status() { return this; }, json(b) { out = b; return this; } };
  await handler({ headers: { authorization: "Bearer sim-cron-secret" } }, res);
  return { out, tried: claims > 0 };
}

let failures = 0;
function expect(label, cond, detail) {
  if (cond) console.log("ok   " + label);
  else { failures++; console.error("FAIL " + label + (detail ? " — " + JSON.stringify(detail) : "")); }
}

const prodLike = await run(scenario({ observedDaysAgo: (NOW - Date.parse("2026-07-30T12:00:00Z")) / DAY, legacyDaysAgo: 0.2, segmentDaysAgo: 0.2 }));
expect("production snapshot (observed dormant, research fresh) sends nothing", !prodLike.tried, prodLike.out);
expect("production snapshot reports the observed tier as dormant, not stale", prodLike.out.observedDormant === true && prodLike.out.observedStale === false, prodLike.out);

const legacyStale = await run(scenario({ observedDaysAgo: 114, legacyDaysAgo: 11, segmentDaysAgo: 11 }));
expect("weekly research 11 days old emails", legacyStale.tried, legacyStale.out);
expect("weekly research 11 days old is reported as legacyStale", legacyStale.out.legacyStale === true, legacyStale.out);

const allDark = await run(scenario({ observedDaysAgo: 114, legacyDaysAgo: 15, segmentDaysAgo: 15 }));
expect("weekly research past 14 days emails", allDark.tried, allDark.out);
expect("weekly research past 14 days is bothDark (dormant tier is no cover)", allDark.out.bothDark === true, allDark.out);

const oneLagging = await run(scenario({ observedDaysAgo: 114, legacyDaysAgo: 0.2, segmentDaysAgo: 0.2, perPlatformLegacy: { Pinterest: 11 } }));
expect("one platform lagging past 10 days emails", oneLagging.tried, oneLagging.out);

if (failures) { console.error(`\n${failures} trend-health alert check(s) failed.`); process.exit(1); }
console.log("OK: trend-health is quiet on today's data and still alarms when the weekly research goes stale.");
