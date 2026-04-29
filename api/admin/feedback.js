// Admin-only feedback inbox. Bearer-token-gated to the admin email.
// Returns the most recent 50 feedback rows (id, user_email, sentiment,
// message, context, created_at). Service-role read so it bypasses the
// service-only RLS we put on the table.

const ADMIN_EMAIL          = "laurenannedoty@gmail.com";
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function verifyAdmin(token) {
  if (!token || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_KEY },
    });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.email && u.email.toLowerCase() === ADMIN_EMAIL.toLowerCase());
  } catch (e) { return false; }
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const ok = await verifyAdmin(auth);
  if (!ok) return res.status(403).json({ error: "Not authorized" });

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/feedback`
      + `?select=id,user_email,sentiment,message,context,created_at`
      + `&order=created_at.desc&limit=50`,
      {
        headers: {
          apikey:        SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return res.status(500).json({ error: text });
    }
    const items = await r.json();
    return res.status(200).json({ items });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
