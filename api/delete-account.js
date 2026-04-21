export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  const headers = {
    'Authorization': `Bearer ${supabaseKey}`,
    'apikey': supabaseKey,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Delete vault content (if stored separately)
    await fetch(`${supabaseUrl}/rest/v1/credits?user_id=eq.${userId}`, {
      method: 'DELETE', headers,
    });

    // 2. Delete the auth user (requires service key)
    const deleteRes = await fetch(
      `${supabaseUrl}/auth/v1/admin/users/${userId}`,
      { method: 'DELETE', headers }
    );

    if (!deleteRes.ok) {
      const err = await deleteRes.json().catch(() => ({}));
      console.error('Auth delete error:', err);
      // Still return 200 — credits deleted, auth may already be gone
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Delete account error:', err);
    return res.status(500).json({ error: err.message });
  }
}