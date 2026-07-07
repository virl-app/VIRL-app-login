// scripts/backfill-email-preferences.mjs
//
// [CONSENT-BACKFILL] One-shot reconciliation for the marketing-consent bug
// fixed in migration 020.
//
// Before migration 020, `public.email_preferences` had RLS enabled with NO
// policy, so the browser's signup-time upsert (index.html, anon key) was
// silently rejected. The row was never written. Because the mailer
// (api/_lib/email-send.js → isMarketingOptedOut) treats a MISSING row as
// "not opted out", any user who UNCHECKED marketing consent at signup could
// still receive marketing email — a consent violation.
//
// The authoritative record of their choice survives in Supabase Auth
// user_metadata.marketing_opt_in (set at signup). This script walks every
// user, and for anyone WITHOUT an email_preferences row, creates one with
// marketing_opt_out = !marketing_opt_in. Existing rows are left untouched
// (resolution=ignore-duplicates) — post-fix, the in-app toggle / unsubscribe
// endpoint own that row and must win.
//
// Idempotent: re-running only ever inserts still-missing rows.
//
// Usage:
//   SUPABASE_URL=...  SUPABASE_SERVICE_KEY=...  node scripts/backfill-email-preferences.mjs
//
// Optional env:
//   BATCH_SIZE  (default 100)   — Supabase admin-users paging size
//   DRY_RUN=true                — log what would be inserted without writing

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BATCH_SIZE           = parseInt(process.env.BATCH_SIZE || "100", 10);
const DRY_RUN              = process.env.DRY_RUN === "true";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing required env: SUPABASE_URL, SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const HEADERS = { apikey: SUPABASE_SERVICE_KEY, Authorization: "Bearer " + SUPABASE_SERVICE_KEY };

async function fetchUsersPage(page, perPage) {
  const r = await fetch(
    SUPABASE_URL + "/auth/v1/admin/users?page=" + page + "&per_page=" + perPage,
    { headers: HEADERS }
  );
  if (!r.ok) {
    const text = await r.text().catch(function(){ return ""; });
    throw new Error("Supabase users page " + page + " failed: " + r.status + " " + text);
  }
  const json = await r.json();
  return Array.isArray(json) ? json : (json.users || []);
}

// Which of these user IDs already have an email_preferences row? One round-trip.
async function fetchExistingIds(userIds) {
  const have = new Set();
  if (!userIds.length) return have;
  const params = "user_id=in.(" + userIds.join(",") + ")&select=user_id";
  const r = await fetch(SUPABASE_URL + "/rest/v1/email_preferences?" + params, { headers: HEADERS });
  if (!r.ok) throw new Error("email_preferences read failed: " + r.status);
  const rows = await r.json();
  for (const row of rows) have.add(row.user_id);
  return have;
}

// Insert the missing rows for one page. ignore-duplicates so a row that
// appears between the read and the write is never overwritten.
async function insertRows(rows) {
  if (!rows.length) return { ok: true };
  if (DRY_RUN) {
    for (const row of rows) console.log("[dry-run] would insert", JSON.stringify(row));
    return { ok: true };
  }
  const r = await fetch(SUPABASE_URL + "/rest/v1/email_preferences", {
    method: "POST",
    headers: {
      ...HEADERS,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const text = await r.text().catch(function(){ return ""; });
    return { ok: false, status: r.status, body: text };
  }
  return { ok: true };
}

async function main() {
  console.log("Starting email_preferences consent backfill" + (DRY_RUN ? " [DRY RUN]" : "") + "...");
  let totalSeen = 0, totalInserted = 0, totalOptOut = 0, totalHad = 0, totalErrored = 0;
  let page = 1;
  const nowIso = new Date().toISOString();

  while (true) {
    const users = await fetchUsersPage(page, BATCH_SIZE);
    if (!users.length) break;

    const userIds = users.map(function(u){ return u.id; }).filter(Boolean);
    const existing = await fetchExistingIds(userIds);

    const toInsert = [];
    for (const u of users) {
      totalSeen++;
      if (!u.id) continue;
      if (existing.has(u.id)) { totalHad++; continue; }
      const meta = u.user_metadata || {};
      // Missing row → derive from the authoritative signup choice. Absent /
      // unchecked consent (marketing_opt_in falsy) → opted OUT.
      const optOut = !meta.marketing_opt_in;
      if (optOut) totalOptOut++;
      toInsert.push({ user_id: u.id, marketing_opt_out: optOut, updated_at: nowIso });
    }

    const result = await insertRows(toInsert);
    if (result.ok) {
      totalInserted += toInsert.length;
    } else {
      totalErrored += toInsert.length;
      console.warn("  [err] page " + page + " -> " + result.status + " " + (result.body || "").slice(0, 200));
    }
    console.log("  ...progress: " + totalSeen + " seen, " + totalInserted + " inserted, " + totalHad + " already had a row");

    if (users.length < BATCH_SIZE) break;
    page++;
  }

  console.log("\nBackfill complete.");
  console.log("  Total seen:            " + totalSeen);
  console.log("  Rows inserted:         " + totalInserted + " (of which opted-OUT: " + totalOptOut + ")");
  console.log("  Already had a row:     " + totalHad);
  console.log("  Errored:               " + totalErrored);
  if (totalErrored > 0) { console.log("\nReview [err] lines and re-run — the script is idempotent."); process.exit(1); }
}

main().catch(function(e){ console.error("Fatal:", e && e.message); process.exit(1); });
