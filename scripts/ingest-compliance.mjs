// scripts/ingest-compliance.mjs
//
// CLI wrapper around api/_lib/compliance-research.js#runIngestion. The
// distillation pipeline + Supabase upserts live in that module so the
// weekly cron (api/cron/compliance-refresh.js) and this script share the
// exact same code path. This file just adds a friendly local invocation
// + a reviewer-facing summary.
//
// Run locally:
//
//   SUPABASE_URL=https://...supabase.co \
//   SUPABASE_SERVICE_KEY=... \
//   ANTHROPIC_API_KEY=sk-... \
//   node scripts/ingest-compliance.mjs
//
// Drafts land at status='draft' in compliance_rules. Generation never
// reads drafts — a human reviews each row in Supabase, sets
// status='approved', and fills reviewed_by + reviewed_at. See README.md
// "Operations → Compliance rules" for the full review loop.

import { runIngestion } from "../api/_lib/compliance-research.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";

function requireEnv() {
  const missing = [];
  if (!process.env.SUPABASE_URL)         missing.push("SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_KEY) missing.push("SUPABASE_SERVICE_KEY");
  if (!process.env.ANTHROPIC_API_KEY)    missing.push("ANTHROPIC_API_KEY");
  if (missing.length) {
    console.error("Missing env vars: " + missing.join(", "));
    process.exit(2);
  }
}

async function main() {
  requireEnv();
  const summary = await runIngestion();

  console.log("");
  console.log("=== Compliance ingestion summary ===");
  console.log("Drafted:   " + summary.drafted);
  console.log("Unchanged: " + summary.unchanged);
  if (summary.skipped.length) {
    console.log("Skipped:");
    for (const s of summary.skipped) console.log("  - " + s.label + ": " + s.reason);
  }
  if (summary.errored.length) {
    console.log("Errored:");
    for (const e of summary.errored) console.log("  - " + e.label + ": " + e.reason);
  }
  if (summary.drafted > 0) {
    console.log("");
    console.log("Review drafts in Supabase:");
    console.log("  " + SUPABASE_URL.replace(/\/$/, "") + "/project/_/editor — table: compliance_rules, filter status=draft");
  }
  console.log("=====================================");
}

main().catch(e => {
  console.error("Ingestion failed:", e.message || e);
  process.exit(1);
});
