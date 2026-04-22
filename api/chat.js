export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, maxTokens, imageBase64, imageType, cost, token } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  // ── Verify session and deduct credits if user is logged in ───────────────
  if (token && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      // Verify the JWT token with Supabase
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'apikey': SUPABASE_SERVICE_KEY,
        },
      });

      if (userRes.ok) {
        const userData = await userRes.json();
        const userId = userData.id;

        // Get user's credits row
        const credRes = await fetch(
          `${SUPABASE_URL}/rest/v1/credits?user_id=eq.${userId}&select=plan,credits`,
          {
            headers: {
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              'apikey': SUPABASE_SERVICE_KEY,
            },
          }
        );

        if (credRes.ok) {
          const credRows = await credRes.json();
          const row = credRows[0];

          if (row) {
            const plan = row.plan;
            const currentCredits = row.credits;
            const creditCost = cost || 1;

            // Founding/pro members bypass credit checks
            const isPro = plan === 'founding' || plan === 'pro' || plan === 'standard';

            if (!isPro && currentCredits < creditCost) {
              return res.status(402).json({ error: 'Not enough credits this week.' });
            }

            // Deduct credits (skip for founding)
            if (plan !== 'founding' && plan !== 'pro') {
              const newCredits = Math.max(0, currentCredits - creditCost);
              await fetch(
                `${SUPABASE_URL}/rest/v1/credits?user_id=eq.${userId}`,
                {
                  method: 'PATCH',
                  headers: {
                    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                    'apikey': SUPABASE_SERVICE_KEY,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal',
                  },
                  body: JSON.stringify({ credits: newCredits }),
                }
              );
            }
          }
        }
      }
    } catch (e) {
      // Non-fatal — continue with generation even if credit deduction fails
      console.error('Credit deduction error:', e.message);
    }
  }

  // ── Call Anthropic API ────────────────────────────────────────────────────
  try {
    const messages = [];
    const content = [];

    // Add image if provided (for VIRL Scan)
    if (imageBase64 && imageType) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: imageType,
          data: imageBase64,
        },
      });
    }

    content.push({ type: 'text', text: prompt });
    messages.push({ role: 'user', content });

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: maxTokens || 1000,
        messages,
      }),
    });

    if (!anthropicRes.ok) {
      const errData = await anthropicRes.json().catch(() => ({}));
      console.error('Anthropic error:', anthropicRes.status, errData);
      return res.status(500).json({
        error: `AI error ${anthropicRes.status}: ${errData.error?.message || 'Unknown error'}`,
      });
    }

    const data = await anthropicRes.json();
    const text = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    return res.status(200).json({ text });

  } catch (e) {
    console.error('Generation error:', e.message);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}