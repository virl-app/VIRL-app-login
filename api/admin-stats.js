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
    //
    // [DASH-ACCURACY] Events are now a 7-DAY WINDOW, not "most recent 500
    // of any type". The old cap made the Feature-usage tiles meaningless
    // once the table passed 500 rows: they became "type share of the last
    // 500 events" and visibly froze. A date filter + generous limit makes
    // the tiles true weekly counts; EVENTS_WINDOW_DAYS is echoed in the
    // response so the client can label them honestly.
    const EVENTS_WINDOW_DAYS = 7;
    const eventsSince = new Date(Date.now() - EVENTS_WINDOW_DAYS * 86400000).toISOString();
    const [credRes, evRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/credits?select=user_id,plan,credits,reset_at,comp_weekly_credits,comp_expires_at,stripe_customer_id,founding_tier,founding_position,subscription_started_at,last_resubscribed_at,resubscription_count&order=user_id`,
        {
          headers: {
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'apikey': SUPABASE_SERVICE_KEY,
          },
        }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/events?select=user_id,event_name,properties,created_at&created_at=gte.${encodeURIComponent(eventsSince)}&order=created_at.desc&limit=5000`,
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

    // [DASH-ACCURACY] The weekly credit refill is LAZY — it runs inside
    // /api/chat on the user's next generation (see the lazy-reset block in
    // chat.js), so the stored `credits` value for anyone who hasn't
    // generated since their reset_at passed is a stale leftover from their
    // last active week. Mirror the refill computation here so the dashboard
    // shows the balance the wallet would hold the moment they generate:
    // comp allowance while a comp is live, else 150 paid / 20 free — the
    // same constants chat.js uses. refill_pending tells the client to mark
    // the value as "due, applies on their next generation" rather than a
    // balance that has already been written to the row.
    const PAID_PLANS = ['founding', 'pro', 'standard'];
    const nowMs = Date.now();
    function effectiveCredits(row) {
      const resetMs = row.reset_at ? Date.parse(row.reset_at) : NaN;
      const refillDue = !row.reset_at || Number.isNaN(resetMs) || resetMs <= nowMs;
      if (!refillDue) return { effective_credits: row.credits, refill_pending: false };
      const compMs = row.comp_expires_at ? Date.parse(row.comp_expires_at) : NaN;
      const compActive = !Number.isNaN(compMs) && compMs > nowMs && row.comp_weekly_credits != null;
      const refill = compActive ? row.comp_weekly_credits
                   : (PAID_PLANS.includes(row.plan) ? 150 : 20);
      return { effective_credits: refill, refill_pending: true };
    }

    // Enrich credits rows with creator name + email so the All-users
    // table can show humans instead of UUID slices. Directory fetch is
    // fail-soft — credits still returns even if profiles or auth admin
    // hiccups; rows just fall back to anonymous.
    const directory = await fetchUserDirectory(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const credits = creditsRaw.map(c => {
      const e = directory.get(c.user_id) || {};
      return Object.assign({}, c, effectiveCredits(c), { name: e.name || null, email: e.email || null });
    });

    return res.status(200).json({ credits, events, events_window_days: EVENTS_WINDOW_DAYS });

  } catch (e) {
    console.error('Admin stats error:', e.message);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}