// api/admin-stats.js
// Server-side endpoint that uses SUPABASE_SERVICE_KEY to fetch all user data
// for the admin dashboard. Bypasses RLS, but only returns data if the caller's
// auth token belongs to the admin email.

import { fetchUserDirectory } from './_lib/admin-users.js';

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

    // Caller is verified admin — fetch credits + events with service key.
    // Don't reference updated_at on credits — that column isn't in the
    // table and PostgREST returns 400, which our previous code silently
    // swallowed into an empty list. Sort by user_id for stable order.
    const [credRes, evRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/credits?select=user_id,plan,credits,stripe_customer_id&order=user_id`,
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

    if (!credRes.ok) {
      const text = await credRes.text().catch(() => '');
      console.error('[admin-stats] credits fetch failed:', credRes.status, text);
    }
    if (!evRes.ok) {
      const text = await evRes.text().catch(() => '');
      console.error('[admin-stats] events fetch failed:', evRes.status, text);
    }

    const creditsRaw = credRes.ok ? await credRes.json() : [];
    const events     = evRes.ok   ? await evRes.json()   : [];

    // Enrich credits rows with creator name + email so the All-users
    // table can show humans instead of UUID slices. Directory fetch is
    // fail-soft — credits still returns even if profiles or auth admin
    // hiccups; rows just fall back to anonymous.
    const directory = await fetchUserDirectory(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const credits = creditsRaw.map(c => {
      const e = directory.get(c.user_id) || {};
      return Object.assign({}, c, { name: e.name || null, email: e.email || null });
    });

    return res.status(200).json({ credits, events });

  } catch (e) {
    console.error('Admin stats error:', e.message);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}