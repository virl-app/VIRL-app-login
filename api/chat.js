export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, maxTokens, imageBase64, imageType, cost, token } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  // ── Optional: verify Supabase session token ──────────────────────────────
  if (token) {
    try {
      const userRes = await fetch(
        `${process.env.SUPABASE_URL}/auth/v1/user`,
        { headers: { 'Authorization': `Bearer ${token}`, 'apikey': process.env.SUPABASE_ANON_KEY } }
      );
      if (!userRes.ok) {
        return res.status(401).json({ error: 'Invalid session - please sign in again.' });
      }

      // ── Deduct credits if cost provided ───────────────────────────────────
      if (cost) {
        const userData = await userRes.json();
        const userId = userData.id;

        const creditRes = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/credits?user_id=eq.${userId}&select=credits,plan`,
          { headers: { 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'apikey': process.env.SUPABASE_SERVICE_KEY } }
        );
        const credits = await creditRes.json();

        if (!credits.length) {
          return res.status(402).json({ error: 'No credit record found.' });
        }

        const current = credits[0].credits;
        const plan = credits[0].plan;

        // Standard/founding members have unlimited credits (150/week resets Monday)
        if (plan === 'free' && current < cost) {
          return res.status(402).json({ error: 'Not enough credits this week. Upgrade or wait for Monday reset.' });
        }

        if (current < cost) {
          return res.status(402).json({ error: 'Not enough credits this week.' });
        }

        // Deduct credits
        await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/credits?user_id=eq.${userId}`,
          {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
              'apikey': process.env.SUPABASE_SERVICE_KEY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ credits: current - cost }),
          }
        );
      }
    } catch (err) {
      console.error('Auth/credit error:', err);
      return res.status(401).json({ error: 'Session verification failed.' });
    }
  }

  // ── Build Anthropic messages ──────────────────────────────────────────────
  const messages = [];

  if (imageBase64) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: imageType || 'image/jpeg',
            data: imageBase64,
          },
        },
        { type: 'text', text: prompt },
      ],
    });
  } else {
    messages.push({ role: 'user', content: prompt });
  }

  // ── Call Anthropic API ────────────────────────────────────────────────────
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: maxTokens || 1000,
        messages,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('Anthropic error:', errData);
      return res.status(500).json({ error: 'AI service error - please try again.' });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    if (!text) {
      return res.status(500).json({ error: 'Empty response from AI - please try again.' });
    }

    return res.status(200).json({ text });

  } catch (err) {
    console.error('Anthropic fetch error:', err);
    return res.status(500).json({ error: 'Connection error - please try again.' });
  }
}