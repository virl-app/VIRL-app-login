// Weekly compliance ingestion cron. Calls runIngestion() to re-fetch the
// canonical agency pages (HUD, NAR, FTC, FDA), distill any changed pages
// into draft rules, and stage them in compliance_rules at status='draft'.
//
// Drafts NEVER reach generation. The prompt builder reads only
// status='approved' rows (see api/_lib/compliance.js). A human reviewer
// opens Supabase, edits rule_text / denylist / compliance_note if needed,
// sets status='approved', and fills reviewed_by + reviewed_at. The loader
// then picks up the new approved row on its next 10-minute cache miss.
//
// Auth: same CRON_SECRET pattern as the other crons. Vercel sends
// `Authorization: Bearer ${CRON_SECRET}` on scheduled invocations.

import { runIngestion } from "../_lib/compliance-research.js";

const CRON_SECRET          = process.env.CRON_SECRET;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  const auth = req.headers.authorization || "";
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }

  let summary;
  try {
    summary = await runIngestion();
  } catch (e) {
    console.error("[cron/compliance-refresh] ingestion threw", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }

  // Plain log so it shows up in Vercel function logs. No email
  // notification in v1 — drafts accumulate quietly until the next
  // reviewer pass. Add a send if the cadence ever turns into "weekly
  // we expect new draft" rather than "drafts only when an agency
  // updates a page".
  console.log("[cron/compliance-refresh] " + JSON.stringify({
    drafted:   summary.drafted,
    unchanged: summary.unchanged,
    skipped:   summary.skipped.length,
    errored:   summary.errored.length,
  }));

  return res.status(200).json({
    ok:        true,
    drafted:   summary.drafted,
    unchanged: summary.unchanged,
    skipped:   summary.skipped,
    errored:   summary.errored,
  });
}
