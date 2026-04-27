import {
  dispatch,
  isValidGenerationType,
  requiresImage,
  ALLOWED_MODELS,
  MODEL_SONNET,
} from "./_lib/prompts.js";

// Free trial length in days. Mirrored in index.html — keep in sync.
const TRIAL_DAYS = 14;
const PAID_PLANS = ['founding', 'pro', 'standard'];

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;

// Lightweight per-user vault summary used to ground the plan generator.
// Same logic the client used to compute via getVaultPatterns(), now read
// from the user_data table so the client never has to disclose vault
// contents on every plan call.
async function fetchVaultPatterns(userId) {
  const empty = { count: 0, topPlatform: null, topFormat: null };
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${userId}&select=vault`,
      { headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY } }
    );
    if (!res.ok) return empty;
    const rows = await res.json();
    const vault = (rows[0] && rows[0].vault) || [];
    const planItems = vault.filter(v => v && v.type === "plan");
    if (!planItems.length) return empty;
    const platformCounts = {};
    const formatCounts   = {};
    for (const v of planItems) {
      if (v.platform) platformCounts[v.platform] = (platformCounts[v.platform] || 0) + 1;
      if (v.format)   formatCounts[v.format]     = (formatCounts[v.format]     || 0) + 1;
    }
    const top = (counts) => {
      let best = null, max = 0;
      for (const k of Object.keys(counts)) if (counts[k] > max) { max = counts[k]; best = k; }
      return best;
    };
    return { count: planItems.length, topPlatform: top(platformCounts), topFormat: top(formatCounts) };
  } catch (e) {
    return empty;
  }
}

async function fetchProfile(userId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=*`,
      { headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY } }
    );
    if (!res.ok) return {};
    const rows = await res.json();
    const data = rows[0];
    if (!data) return {};
    // Translate snake_case columns to the camelCase the prompt builders expect.
    return {
      name:              data.name              || "",
      audience:          data.audience          || "",
      voice:             data.voice             || "",
      myPlatforms:       data.my_platforms      || [],
      vibes:             data.vibes             || [],
      sampleCaption:     data.sample_caption    || "",
      topics:            data.topics            || "",
      purpose:           data.purpose           || "",
      offLimits:         data.off_limits        || "",
      inspiration:       data.inspiration       || "",
      journey:           data.journey           || "",
      knownFor:          data.known_for         || "",
      pillars:           data.pillars           || [],
      emojiPref:         data.emoji_pref        || "Sometimes",
      handles:           data.handles           || {},
      platformAudiences: data.platform_audiences || {},
      postFreq:          data.post_freq         || "",
      contentLength:     data.content_length    || "",
      workedWell:        data.worked_well       || "",
    };
  } catch (e) {
    return {};
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    generationType,
    params,
    imageBase64,
    imageType,
    token: bodyToken,
  } = req.body || {};

  // Validate the generation type up front so a bad type never reaches Anthropic.
  if (!generationType || !isValidGenerationType(generationType)) {
    return res.status(400).json({ error: 'Invalid generationType.' });
  }
  if (requiresImage(generationType) && !imageBase64) {
    return res.status(400).json({ error: 'This generation type requires an image.' });
  }

  // ── Auth (fail closed) ────────────────────────────────────────────────────
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Server misconfigured.' });
  }
  // Token may come from either an Authorization header or the legacy body
  // field — this endpoint historically accepted the latter, and changing the
  // client at the same time as everything else would mean two breaking
  // surfaces in one PR. The header is preferred going forward.
  const authHeader = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const token = authHeader || bodyToken;
  if (!token) return res.status(401).json({ error: 'Sign in required.' });

  let userId, createdAt;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_SERVICE_KEY },
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Sign in required.' });
    const userJson = await userRes.json();
    userId    = userJson.id;
    createdAt = userJson.created_at;
  } catch (e) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  // ── Build the prompt server-side ──────────────────────────────────────────
  // Profile + vault patterns come from Supabase, not the client, so the
  // prompt template never has to be exposed in the browser.
  const profile = await fetchProfile(userId);
  const vaultPatterns = (generationType === "plan") ? await fetchVaultPatterns(userId) : null;

  let built;
  try {
    built = dispatch(generationType, params, profile, vaultPatterns);
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Bad request.' });
  }

  const selectedModel = ALLOWED_MODELS.includes(built.model) ? built.model : MODEL_SONNET;
  const creditCost    = built.cost || 1;

  // ── Credit check & deduction ──────────────────────────────────────────────
  try {
    const credRes = await fetch(
      `${SUPABASE_URL}/rest/v1/credits?user_id=eq.${userId}&select=plan,credits`,
      { headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY } }
    );
    if (!credRes.ok) return res.status(500).json({ error: 'Could not verify credits.' });

    const [row] = await credRes.json();
    if (!row) return res.status(402).json({ error: 'Not enough credits this week.' });

    const { plan, credits: currentCredits } = row;
    const isPaid = PAID_PLANS.includes(plan);

    // Trial enforcement: free users get TRIAL_DAYS from signup. The client
    // already blocks past day 14, but the cap is meaningless if the API
    // doesn't enforce it too. Fail open when created_at is missing so a
    // malformed auth row doesn't lock real users out.
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

  // ── Build Anthropic request ───────────────────────────────────────────────
  try {
    // System prompt uses prompt caching: cache_control: ephemeral → Anthropic
    // caches this block server-side for 1 hour. On cache hit, cached tokens
    // cost ~10% of normal input price. Most impactful for plan generation
    // where the full creator profile is sent on every call. The beta header
    // is required to enable caching.
    const useCache = !!(built.systemPrompt && built.systemPrompt.trim());
    const systemBlock = useCache
      ? [{ type: 'text', text: built.systemPrompt, cache_control: { type: 'ephemeral' } }]
      : undefined;

    const content = [];
    if (imageBase64 && imageType) {
      content.push({ type: 'image', source: { type: 'base64', media_type: imageType, data: imageBase64 } });
    }
    content.push({ type: 'text', text: built.userPrompt });

    const payload = {
      model:      selectedModel,
      max_tokens: built.maxTokens || 1000,
      messages:   [{ role: 'user', content }],
      ...(systemBlock ? { system: systemBlock } : {}),
    };

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
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

    if (data.usage) {
      console.log('virl_usage', JSON.stringify({
        generationType,
        model:               selectedModel,
        input_tokens:        data.usage.input_tokens,
        output_tokens:       data.usage.output_tokens,
        cache_read_tokens:   data.usage.cache_read_input_tokens || 0,
        cache_write_tokens:  data.usage.cache_creation_input_tokens || 0,
      }));
    }

    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    // `cost` flows back so the client can do an optimistic credit-counter
    // tick without needing to know the cost table itself.
    return res.status(200).json({ text, cost: creditCost });

  } catch (e) {
    console.error('Generation error:', e.message);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}
