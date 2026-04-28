// Admin endpoint for approving or rejecting a single playbook draft.
//
// POST body: { draft_id: <int>, action: "approve" | "reject" }
//
// Approve: upserts the draft's `proposed` object into the live playbook
// table, then marks the draft 'approved'. Reject: marks the draft
// 'rejected' without touching the live playbook.
//
// Auth: bearer-token must belong to the admin email — same pattern as
// admin-stats.js / playbook-update.js.

const ADMIN_EMAIL          = "laurenannedoty@gmail.com";
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ALLOWED_FIELDS = [
  "platform", "cadence", "peak_times", "duration", "hook_window",
  "hashtag_count", "hashtag_mix", "caption_limit", "top_signals",
  "format_priority", "notes",
];

const SUPABASE_HEADERS = {
  apikey:        SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function verifyAdmin(token) {
  if (!token || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!r.ok) return null;
    const u = await r.json();
    if (!u || !u.email) return null;
    if (u.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return null;
    return u;
  } catch (e) { return null; }
}

async function loadDraft(draftId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/playbook_drafts?id=eq.${encodeURIComponent(draftId)}&select=*`,
    { headers: SUPABASE_HEADERS }
  );
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

async function commitProposedToPlaybook(proposed) {
  // Whitelist fields so a malformed `proposed` blob can't inject extra
  // columns. Drop nullish fields except caption_limit (which can legitimately
  // be null for platforms without a hard cap).
  const payload = { updated_at: new Date().toISOString() };
  for (const k of ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(proposed, k)) payload[k] = proposed[k];
  }
  if (!payload.platform) throw new Error("draft is missing platform");
  const r = await fetch(`${SUPABASE_URL}/rest/v1/playbook`, {
    method:  "POST",
    headers: Object.assign({}, SUPABASE_HEADERS, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error("playbook upsert " + r.status + " " + text);
  }
}

async function markDraft(draftId, status, reviewerId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/playbook_drafts?id=eq.${encodeURIComponent(draftId)}`,
    {
      method:  "PATCH",
      headers: Object.assign({}, SUPABASE_HEADERS, { Prefer: "return=minimal" }),
      body: JSON.stringify({
        status,
        reviewed_at: new Date().toISOString(),
        reviewed_by: reviewerId,
      }),
    }
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error("draft mark " + r.status + " " + text);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const admin = await verifyAdmin(auth);
  if (!admin) return res.status(403).json({ error: "Not authorized" });

  const body = req.body || {};
  const draftId = body.draft_id;
  const action  = body.action;
  if (!draftId)                                   return res.status(400).json({ error: "draft_id is required" });
  if (action !== "approve" && action !== "reject") return res.status(400).json({ error: "action must be 'approve' or 'reject'" });

  const draft = await loadDraft(draftId);
  if (!draft)                  return res.status(404).json({ error: "draft not found" });
  if (draft.status !== "pending") return res.status(409).json({ error: "draft already " + draft.status });

  if (action === "approve") {
    try { await commitProposedToPlaybook(draft.proposed || {}); }
    catch (e) {
      console.error("[playbook-draft-review] approve failed", e.message);
      return res.status(500).json({ error: "Approve failed: " + e.message });
    }
  }

  try { await markDraft(draftId, action === "approve" ? "approved" : "rejected", admin.id); }
  catch (e) {
    console.error("[playbook-draft-review] mark failed", e.message);
    return res.status(500).json({ error: "Mark failed: " + e.message });
  }

  return res.status(200).json({ ok: true, action });
}
