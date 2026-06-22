// scripts/backfill-loops-contacts.mjs
//
// [EMAIL-CUTOVER] One-shot backfill script that pushes every existing
// VIRL user's `signupAt` + `marketingSubscribed` into their Loops
// contact, so Loops audience filters keyed on those properties (trial-
// day-N from signupAt, marketing suppression from marketingSubscribed)
// work for users who signed up before migration 003 ran.
//
// [LOOPS-PLAN] Also backfills `plan` + `daysIntoTrial`. Contacts created
// before the welcome/cron changes have a BLANK plan, which silently fails
// the trial-conversion workflows' `plan == "free"` filter. This script is
// how those existing contacts self-correct — they won't otherwise update
// until the daily cron sync next touches them. Run once after deploy.
//
// Why this exists: without the backfill, only NEW signups after
// /api/email/welcome's updateLoopsContact change will have the §9
// properties populated. Existing contacts are invisible to the new
// audience filters until this script runs.
//
// Idempotent: re-running just re-PUTs the same values. Safe to retry
// after partial failures.
//
// Usage:
//   SUPABASE_URL=...  \
//   SUPABASE_SERVICE_KEY=...  \
//   LOOPS_API_KEY=...  \
//   node scripts/backfill-loops-contacts.mjs
//
// Optional env:
//   BATCH_SIZE   (default 100)  — Loops contacts/update is one-at-a-time,
//                                  this is just the Supabase paging size
//   DRY_RUN=true                  — log what would be PUT without firing
//   SLEEP_MS     (default 50)   — delay between Loops PUT calls to stay
//                                  under their rate ceiling (10 req/s)
//
// Output: progress every 50 contacts, a final summary with totals.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const LOOPS_API_KEY        = process.env.LOOPS_API_KEY;
const BATCH_SIZE           = parseInt(process.env.BATCH_SIZE || "100", 10);
const SLEEP_MS             = parseInt(process.env.SLEEP_MS   || "50",  10);
const DRY_RUN              = process.env.DRY_RUN === "true";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !LOOPS_API_KEY) {
  console.error("Missing required env: SUPABASE_URL, SUPABASE_SERVICE_KEY, LOOPS_API_KEY");
  process.exit(1);
}

const LOOPS_BASE = "https://app.loops.so/api/v1";

function sleep(ms) {
  return new Promise(function(r){ setTimeout(r, ms); });
}

// [LOOPS-PLAN] Inlined copies of api/_lib/loops.js helpers — kept local so
// this script stays dependency-free (it deliberately inlines its own Loops
// PUT rather than importing the serverless module). Must mirror that file:
// free/trial → "free", paid tiers pass through, cancelled/past_due preserved.
function loopsPlanValue(supabasePlan) {
  const p = (supabasePlan == null ? "" : String(supabasePlan)).trim().toLowerCase();
  if (p === "founding" || p === "standard" || p === "pro") return p;
  if (p === "cancelled" || p === "canceled") return "cancelled";
  if (p === "past_due"  || p === "unpaid")   return "past_due";
  return "free";
}
function computeDaysIntoTrial(signupAtIso) {
  const t = Date.parse(signupAtIso);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

// Page through auth.users via the Supabase admin API. Returns the users
// array for one page plus a hint at whether more pages exist (Supabase's
// page param is 1-indexed).
async function fetchUsersPage(page, perPage) {
  const r = await fetch(
    SUPABASE_URL + "/auth/v1/admin/users?page=" + page + "&per_page=" + perPage,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_KEY } }
  );
  if (!r.ok) {
    const text = await r.text().catch(function(){ return ""; });
    throw new Error("Supabase users page " + page + " failed: " + r.status + " " + text);
  }
  const json = await r.json();
  // Supabase returns { users: [...], aud, nextPage, lastPage } shape.
  const users = Array.isArray(json) ? json : (json.users || []);
  return users;
}

// Read email_preferences rows for a batch of user IDs in one round-trip.
// Returns a Map keyed by user_id → marketing_opt_out boolean.
async function fetchOptOutMap(userIds) {
  const out = new Map();
  if (!userIds.length) return out;
  const params = "user_id=in.(" + userIds.join(",") + ")&select=user_id,marketing_opt_out";
  const r = await fetch(
    SUPABASE_URL + "/rest/v1/email_preferences?" + params,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_KEY } }
  );
  if (!r.ok) return out; // fail open — missing row falls through to the user_metadata default
  const rows = await r.json();
  for (const row of rows) out.set(row.user_id, !!row.marketing_opt_out);
  return out;
}

// [LOOPS-PLAN] Read credits.plan for a batch of user IDs in one round-trip.
// Returns a Map user_id → plan string. Users with no credits row are absent
// from the map; the caller maps that (and any unknown value) to "free".
async function fetchPlanMap(userIds) {
  const out = new Map();
  if (!userIds.length) return out;
  const params = "user_id=in.(" + userIds.join(",") + ")&select=user_id,plan";
  const r = await fetch(
    SUPABASE_URL + "/rest/v1/credits?" + params,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_KEY } }
  );
  if (!r.ok) return out; // fail open — missing plan falls through to "free"
  const rows = await r.json();
  for (const row of rows) out.set(row.user_id, row.plan);
  return out;
}

// PUT one contact's properties to Loops. updateLoopsContact's full body
// shape: { userId, email, ...customProperties }. Loops resolves the
// contact by userId or email.
async function putLoopsContact(contact) {
  if (DRY_RUN) {
    console.log("[dry-run] would PUT", JSON.stringify(contact));
    return { ok: true };
  }
  const r = await fetch(LOOPS_BASE + "/contacts/update", {
    method: "PUT",
    headers: {
      Authorization:  "Bearer " + LOOPS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(contact),
  });
  if (!r.ok) {
    const text = await r.text().catch(function(){ return ""; });
    return { ok: false, status: r.status, body: text };
  }
  return { ok: true };
}

async function main() {
  console.log("Starting Loops contact backfill" + (DRY_RUN ? " [DRY RUN]" : "") + "...");
  let totalSeen     = 0;
  let totalSynced   = 0;
  let totalSkipped  = 0;
  let totalErrored  = 0;
  let page          = 1;

  while (true) {
    const users = await fetchUsersPage(page, BATCH_SIZE);
    if (!users.length) break;

    const userIds = users.map(function(u){ return u.id; }).filter(Boolean);
    const optOutMap = await fetchOptOutMap(userIds);
    const planMap   = await fetchPlanMap(userIds);

    for (const u of users) {
      totalSeen++;
      if (!u.email || !u.id) { totalSkipped++; continue; }
      const meta = u.user_metadata || {};
      const optOut = optOutMap.has(u.id) ? optOutMap.get(u.id) : !meta.marketing_opt_in;
      const contact = {
        userId:              u.id,
        email:               u.email,
        firstName:           meta.first_name || meta.name || undefined,
        lastName:            meta.last_name  || undefined,
        signupAt:            u.created_at || undefined,
        marketingSubscribed: !optOut,
        // [LOOPS-PLAN] Fixes the blank-plan contacts: free/trial → "free",
        // paid tiers preserved. daysIntoTrial recomputed from signup.
        plan:                loopsPlanValue(planMap.get(u.id)),
        daysIntoTrial:       computeDaysIntoTrial(u.created_at),
      };

      const result = await putLoopsContact(contact);
      if (result.ok) {
        totalSynced++;
      } else {
        totalErrored++;
        console.warn("  [err] " + u.id + " " + u.email + " -> " + result.status + " " + (result.body || "").slice(0, 200));
      }

      if (totalSeen % 50 === 0) {
        console.log("  ...progress: " + totalSeen + " seen, " + totalSynced + " synced, " + totalErrored + " errored");
      }
      await sleep(SLEEP_MS);
    }

    if (users.length < BATCH_SIZE) break;
    page++;
  }

  console.log("\nBackfill complete.");
  console.log("  Total seen:    " + totalSeen);
  console.log("  Total synced:  " + totalSynced);
  console.log("  Total skipped: " + totalSkipped + " (missing email or user_id)");
  console.log("  Total errored: " + totalErrored);
  if (totalErrored > 0) {
    console.log("\nReview the [err] lines above and re-run — the script is idempotent.");
    process.exit(1);
  }
}

main().catch(function(e){
  console.error("Fatal:", e && e.message);
  process.exit(1);
});
