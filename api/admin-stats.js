// api/admin-stats.js
// Server-side endpoint that uses SUPABASE_SERVICE_KEY to fetch all user data
// for the admin dashboard. Bypasses RLS, but only returns data if the caller's
// auth token belongs to the admin email.

const ADMIN_EMAIL = 'laurenannedoty@gmail.com';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  // Extract bearer token from the Authorization header
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  // Verify the token belongs to the admin by calling Supabase auth
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_SERVICE_KEY,
      },
    });

    if (!userRes.ok) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const user = await userRes.json();
    if (!user || !user.email || user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Caller is verified admin — fetch credits + events with service key
    const [credRes, evRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/credits?select=user_id,plan,credits,stripe_customer_id,updated_at&order=updated_at.desc`,
        {
          headers: {
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'apikey': SUPABASE_SERVICE_KEY,
          },
        }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/events?select=user_id,event_name,properties,created_at&order=created_at.desc&limit=500`,
        {
          headers: {
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'apikey': SUPABASE_SERVICE_KEY,
          },
        }
      ),
    ]);

    const credits = credRes.ok ? await credRes.json() : [];
    const events = evRes.ok ? await evRes.json() : [];

    return res.status(200).json({ credits, events });

  } catch (e) {
    console.error('Admin stats error:', e.message);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}