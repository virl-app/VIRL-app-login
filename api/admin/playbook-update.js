// Admin-only endpoint for editing playbook rows. Auth: bearer token must
// belong to the admin email. Same shape as admin-stats.js.
//
// POST body: {
//   platform:        "TikTok",
//   cadence:         "1-3 posts/day",
//   peak_times:      "...",
//   duration:        "...",
//   hook_window:     "...",
//   hashtag_count:   "3-5",
//   hashtag_mix:     "...",
//   caption_limit:   150,
//   top_signals:     ["watch time", ...],
//   format_priority: ["short video", ...],
//   notes:           "..."
// }

const ADMIN_EMAIL          = "laurenannedoty@gmail.com";
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ALLOWED_FIELDS = [
  "platform", "cadence", "peak_times", "duration", "hook_window",
  "hashtag_count", "hashtag_mix", "caption_limit", "top_signals",
  "format_priority", "notes",
];

async function verifyAdmin(token) {
  if (!token || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!res.ok) return false;
    const user = await res.json();
    return !!(user && user.email && user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase());
  } catch (e) {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth  = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const ok    = await verifyAdmin(auth);
  if (!ok) return res.status(403).json({ error: "Not authorized" });

  const body = req.body || {};
  if (!body.platform || typeof body.platform !== "string") {
    return res.status(400).json({ error: "platform is required" });
  }

  // Whitelist fields so an admin can't accidentally inject arbitrary columns.
  const payload = { updated_at: new Date().toISOString() };
  for (const k of ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) payload[k] = body[k];
  }

  try {
    const res2 = await fetch(`${SUPABASE_URL}/rest/v1/playbook`, {
      method: "POST",
      headers: {
        apikey:        SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer:        "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(payload),
    });
    const text = await res2.text();
    if (!res2.ok) {
      console.error("[playbook-update] supabase error", res2.status, text);
      return res.status(500).json({ error: "Save failed: " + text });
    }
    return res.status(200).json({ ok: true, row: text ? JSON.parse(text)[0] : null });
  } catch (e) {
    console.error("[playbook-update] threw", e.message);
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
