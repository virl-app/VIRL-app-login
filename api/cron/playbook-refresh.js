// Monthly playbook research cron. For each platform, calls Claude with
// web_search against the trusted-source allowlist (see playbook-research.js)
// and stages a row in playbook_drafts when meaningful changes are
// proposed. Sends one consolidated admin notification email at the end.
//
// Conservative-by-default: drafts wait for admin approval before reaching
// the live playbook. Approve/Reject flow lives in api/admin/playbook-draft-review.js
// + the Admin Dashboard tab.
//
// Auth: same CRON_SECRET pattern as the other crons. Vercel sends
// `Authorization: Bearer ${CRON_SECRET}` on scheduled invocations.

import { researchPlatform } from "../_lib/playbook-research.js";
import { sendEmail }        from "../_lib/email-send.js";
import { playbookRefreshReport } from "../_lib/email-templates.js";
import { cronAuthorized }   from "../_lib/cron-auth.js";
import { PLAYBOOK_STALE_DAYS } from "../_lib/playbook.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_EMAIL          = "laurenannedoty@gmail.com";

const PLATFORMS = ["TikTok","Instagram","Facebook","YouTube","LinkedIn","X","Pinterest"];

const SUPABASE_HEADERS = {
  apikey:        SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function fetchPlaybook() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/playbook?select=*`, { headers: SUPABASE_HEADERS });
  if (!res.ok) throw new Error("playbook fetch " + res.status);
  const rows = await res.json();
  const map = {};
  for (const r of rows) if (r && r.platform) map[r.platform] = r;
  return map;
}

// Builds a per-field diff between the current entry and the model's proposal.
// Only includes fields the model actually wants to change.
function buildDiff(currentEntry, proposed) {
  const diff = {};
  if (!proposed || typeof proposed !== "object") return diff;
  for (const field of Object.keys(proposed)) {
    const change = proposed[field];
    if (!change || typeof change !== "object" || !("new_value" in change)) continue;
    const oldValue = currentEntry ? currentEntry[field] : null;
    diff[field] = {
      old: oldValue === undefined ? null : oldValue,
      new: change.new_value,
      source_url: change.source_url || null,
      reason:     change.reason     || null,
    };
  }
  return diff;
}

// Build the proposed full row by overlaying the model's changes onto the
// current entry. The admin's Approve action writes this whole object via
// upsert into the playbook table.
function buildProposed(currentEntry, proposedChanges) {
  const next = currentEntry ? Object.assign({}, currentEntry) : {};
  for (const field of Object.keys(proposedChanges || {})) {
    const change = proposedChanges[field];
    if (change && "new_value" in change) next[field] = change.new_value;
  }
  // Strip server-managed fields so the admin upsert doesn't accidentally
  // try to clobber timestamps with stale values.
  delete next.updated_at;
  return next;
}

// [PLAYBOOK-ALERT] How long a pending draft may sit before the run report
// nags about it. A draft nobody approves is indistinguishable, from the live
// playbook's point of view, from research that never ran: the old row keeps
// serving and keeps aging toward PLAYBOOK_STALE_DAYS, at which point the
// prompts withdraw its authority. The cron is monthly, so 30 days means the
// nag fires on the first run after a draft was skipped — one reminder per
// missed cycle, which is the slowest cadence that still catches it before the
// staleness window closes.
const PENDING_DRAFT_NAG_DAYS = 30;

// Count drafts still sitting in `pending` past the nag window. Best-effort: a
// failed count must never block the run report the errors above depend on, so
// it returns 0 rather than throwing.
async function countStalePendingDrafts(nowMs) {
  const cutoff = new Date(nowMs - PENDING_DRAFT_NAG_DAYS * 86400000).toISOString();
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/playbook_drafts?status=eq.pending&created_at=lt.${encodeURIComponent(cutoff)}&select=id`,
      { headers: Object.assign({}, SUPABASE_HEADERS, { Prefer: "count=exact" }) }
    );
    if (!res.ok) return 0;
    const rows = await res.json();
    return Array.isArray(rows) ? rows.length : 0;
  } catch (e) {
    console.error("[cron/playbook-refresh] stale-draft count failed", e && e.message);
    return 0;
  }
}

async function insertDraft(platform, proposed, diff, reasoning, sources) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/playbook_drafts`, {
    method:  "POST",
    headers: Object.assign({}, SUPABASE_HEADERS, { Prefer: "return=minimal" }),
    body: JSON.stringify({
      platform,
      proposed,
      diff,
      reasoning,
      sources: sources || [],
      status:  "pending",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[cron/playbook-refresh] insert draft failed for", platform, res.status, text);
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  if (!cronAuthorized(req, "playbook-refresh")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server misconfigured." });
  }

  let playbook;
  try { playbook = await fetchPlaybook(); }
  catch (e) {
    console.error("[cron/playbook-refresh] could not fetch playbook", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }

  const summaries = []; // for the admin notification email
  // [PLAYBOOK-ALERT] Failures are now collected with a reason, not just
  // tallied. `errored` was already counted and returned in the JSON response —
  // which nothing reads — so the number existed and the signal didn't. The
  // reasons make the email actionable: "web_search returned nothing" and
  // "Supabase insert rejected the row" are different outages with different
  // fixes, and a bare count can't tell them apart.
  const errors = [];
  let drafted = 0;
  let skipped = 0;
  let errored = 0;

  function recordError(platform, reason) {
    errored++;
    errors.push({ platform, reason });
  }

  for (const platform of PLATFORMS) {
    const currentEntry = playbook[platform];
    if (!currentEntry) {
      console.warn("[cron/playbook-refresh] no current entry for", platform, "— skipping");
      skipped++;
      continue;
    }

    let result;
    try { result = await researchPlatform(platform, currentEntry); }
    catch (e) {
      console.error("[cron/playbook-refresh] research threw for", platform, e.message);
      recordError(platform, "research threw: " + (e && e.message ? e.message : "unknown error"));
      continue;
    }

    if (!result) { recordError(platform, "research returned no usable result"); continue; }
    if (result.no_changes_needed === true) { skipped++; continue; }

    const proposedChanges = result.proposed_changes || {};
    if (!Object.keys(proposedChanges).length) { skipped++; continue; }

    const diff      = buildDiff(currentEntry, proposedChanges);
    const proposed  = buildProposed(currentEntry, proposedChanges);
    const reasoning = result.summary || "";
    const sources   = Array.isArray(result.sources) ? result.sources : [];

    const ok = await insertDraft(platform, proposed, diff, reasoning, sources);
    if (ok) {
      drafted++;
      summaries.push({ platform, summary: reasoning });
    } else {
      recordError(platform, "changes were researched but staging the draft failed");
    }
  }

  // [PLAYBOOK-ALERT] Approval is the last link in this chain and the only one
  // with a human in it, so it gets the same treatment as the automated links:
  // a draft that has sat unapproved for a month is reported, not assumed
  // handled.
  const stalePending = await countStalePendingDrafts(Date.now());

  // Resolve admin user id so the email send dedupe is tied to that account.
  let adminUserId = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(ADMIN_EMAIL)}`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    if (r.ok) {
      const j = await r.json();
      const u = (j.users && j.users[0]) || null;
      if (u && u.id) adminUserId = u.id;
    }
  } catch (e) { /* non-fatal */ }

  // Notification email — one per cron run, dedupe-keyed by the run date so
  // re-running the cron the same day is a no-op.
  //
  // [PLAYBOOK-ALERT] The gate was `drafted > 0`, which made a total research
  // outage look exactly like a quiet month: no drafts, no email, no signal.
  // It now fires on any of the three states worth a human's attention —
  // something failed, something is staged, or something staged has been
  // ignored too long. A run where research succeeded and proposed no changes
  // still sends nothing, which is the only case where silence is honest.
  const shouldNotify = drafted > 0 || errored > 0 || stalePending > 0;
  let emailed = false;
  if (shouldNotify && adminUserId) {
    const tpl = playbookRefreshReport({
      drafted,
      summaries,
      errored,
      errors,
      stalePending,
      stalePendingDays: PENDING_DRAFT_NAG_DAYS,
    });
    const dedupeKey = "playbook_refresh_" + new Date().toISOString().slice(0, 10);
    emailed = await sendEmail({
      userId:    adminUserId,
      to:        ADMIN_EMAIL,
      template:  "playbook_refresh_report",
      dedupeKey,
      subject:   tpl.subject,
      html:      tpl.html,
      text:      tpl.text,
      marketing: false,
    });
  }

  // `errors` rides the response too. It is still not a substitute for the
  // email — nothing polls this endpoint's body — but when someone IS looking
  // at a run, the reasons beat a bare count.
  return res.status(200).json({ ok: true, drafted, skipped, errored, errors, stalePending, staleDays: PLAYBOOK_STALE_DAYS, emailed });
}
