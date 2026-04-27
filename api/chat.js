export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    prompt, maxTokens, imageBase64, imageType,
    cost, token, model, systemPrompt,
  } = req.body;

  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  const SUPABASE_URL        = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;

  // ── Model selection ────────────────────────────────────────────────────────
  // Allowlist prevents callers from arbitrarily picking expensive models.
  const ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
  const selectedModel  = ALLOWED_MODELS.includes(model) ? model : 'claude-sonnet-4-6';

  // Free trial length in days. Mirrored in index.html — keep in sync.
  const TRIAL_DAYS = 14;
  const PAID_PLANS = ['founding', 'pro', 'standard'];

  // ── Credit check & deduction ───────────────────────────────────────────────
  // Fail closed: every generation must be tied to an authenticated user so the
  // weekly cap is enforced. Without this, a caller could bypass the limit by
  // simply not sending a token (e.g. hitting the endpoint directly).
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Server misconfigured.' });
  }
  if (!token) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_SERVICE_KEY },
    });

    if (!userRes.ok) {
      return res.status(401).json({ error: 'Sign in required.' });
    }

    const userJson = await userRes.json();
    const { id: userId, created_at: createdAt } = userJson;

    const credRes = await fetch(
      `${SUPABASE_URL}/rest/v1/credits?user_id=eq.${userId}&select=plan,credits`,
      { headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY } }
    );

    if (!credRes.ok) {
      return res.status(500).json({ error: 'Could not verify credits.' });
    }

    const [row] = await credRes.json();
    if (!row) {
      return res.status(402).json({ error: 'Not enough credits this week.' });
    }

    const { plan, credits: currentCredits } = row;
    const creditCost = cost || 1;
    const isPaid = PAID_PLANS.includes(plan);

    // Trial enforcement: free users get TRIAL_DAYS from signup. The client
    // already blocks generation past day 14, but the cap is meaningless if
    // the API doesn't enforce it too — anyone hitting the endpoint directly
    // could keep generating until their weekly credits hit zero. Fail open
    // when created_at is missing so a malformed auth row doesn't lock real
    // users out; the client warning surfaces it for triage.
    if (!isPaid && createdAt) {
      const signupMs = Date.parse(createdAt);
      if (!Number.isNaN(signupMs)) {
        const daysSinceSignup = Math.floor((Date.now() - signupMs) / 86400000);
        if (daysSinceSignup >= TRIAL_DAYS) {
          return res.status(402).json({ error: 'Your free trial has ended.' });
        }
      }
    }

    if (!isPaid && currentCredits < creditCost) {
      return res.status(402).json({ error: 'Not enough credits this week.' });
    }

    if (!['founding','pro'].includes(plan)) {
      await fetch(`${SUPABASE_URL}/rest/v1/credits?user_id=eq.${userId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'apikey': SUPABASE_SERVICE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ credits: Math.max(0, currentCredits - creditCost) }),
      });
    }
  } catch (e) {
    console.error('Credit check error:', e.message);
    return res.status(500).json({ error: 'Could not verify credits.' });
  }

  // ── Build Anthropic request ────────────────────────────────────────────────
  try {
    // System prompt with prompt caching
    // cache_control: ephemeral → Anthropic caches this block server-side for 1 hour.
    // On cache hit, cached tokens cost ~10% of normal input price.
    // Most impactful for plan generation where the full creator profile is sent
    // on every call. The beta header is required to enable caching.
    const useCache   = !!(systemPrompt && systemPrompt.trim());
    const systemBlock = useCache
      ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
      : undefined;

    // User message
    const content = [];
    if (imageBase64 && imageType) {
      content.push({ type: 'image', source: { type: 'base64', media_type: imageType, data: imageBase64 } });
    }
    content.push({ type: 'text', text: prompt });

    const payload = {
      model: selectedModel,
      max_tokens: maxTokens || 1000,
      messages: [{ role: 'user', content }],
      ...(systemBlock ? { system: systemBlock } : {}),
    };

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        ...(useCache ? { 'anthropic-beta': 'prompt-caching-2024-07-31' } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({}));
      console.error('Anthropic error:', anthropicRes.status, err);
      return res.status(500).json({
        error: `AI error ${anthropicRes.status}: ${err.error?.message || 'Unknown'}`,
      });
    }

    const data = await anthropicRes.json();

    // Log token usage + cache performance to Vercel logs
    if (data.usage) {
      console.log('virl_usage', JSON.stringify({
        model: selectedModel,
        input_tokens:        data.usage.input_tokens,
        output_tokens:       data.usage.output_tokens,
        cache_read_tokens:   data.usage.cache_read_input_tokens || 0,
        cache_write_tokens:  data.usage.cache_creation_input_tokens || 0,
      }));
    }

    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return res.status(200).json({ text });

  } catch (e) {
    console.error('Generation error:', e.message);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}
