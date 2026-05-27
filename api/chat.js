import {
  dispatch,
  isValidGenerationType,
  requiresImage,
  ALLOWED_MODELS,
  MODEL_SONNET,
} from "./_lib/prompts.js";
import { loadPlaybook }              from "./_lib/playbook.js";
import { loadLatestTrends }          from "./_lib/trends.js";
import { fetchInlineTrends, isValidTrendsSnapshot } from "./_lib/fresh-trends-inline.js";
import { loadPlanHistoryForPrompt }  from "./_lib/plan-history.js";
import { sendEmail }                 from "./_lib/email-send.js";
import { firstPlanGenerated, referralMilestone } from "./_lib/email-templates.js";
import { makeUnsubToken }            from "./_lib/unsub-token.js";
import { estimateCostUSD }           from "./_lib/pricing.js";

// Free trial length in days. Mirrored in index.html — keep in sync.
const TRIAL_DAYS = 14;
const PAID_PLANS = ['founding', 'pro', 'standard'];

// Gen types that can be backed by inline fresh-trends research and the
// `credits` column that gates each one for free-trial users. Paid users
// (PAID_PLANS) bypass the gate entirely; each free user gets one freebie
// per gen type per credit-week (resets alongside `credits.reset_at`).
const FRESH_TRENDS_COLUMNS = {
  plan:    'fresh_trends_plan_remaining',
  scan:    'fresh_trends_scan_remaining',
  caption: 'fresh_trends_caption_remaining',
};
// Map every concrete generationType to one of the keys above (or null
// if the type doesn't get inline fresh trends). plan_partial /
// plan_strategy / regen all inherit the parent plan's snapshot via the
// client-supplied trendsSnapshot rather than firing Perplexity again.
const FRESH_TRENDS_TYPE = {
  plan:             'plan',
  scan_image:       'scan',
  scan_video_frame: 'scan',
  caption:          'caption',
};

// Rate-limit ceilings for /api/chat. Tunable; the credit cap is the wallet
// limit, these only catch burst abuse and runaway scripts. Both windows are
// well above any plausible real usage.
const RATE_LIMIT_PER_MINUTE = 5;
const RATE_LIMIT_PER_HOUR   = 30;

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;

// Best-effort fetch of the user's email + name for the inline onboarding
// email. Returns nulls on any failure — the caller treats nulls as "skip".
async function fetchUserContactForEmail(userId) {
  const out = { email: null, name: "" };
  if (!userId || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return out;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    if (r.ok) {
      const u = await r.json();
      out.email = u.email || null;
    }
  } catch (e) { /* non-fatal */ }
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=name`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (r.ok) {
      const rows = await r.json();
      if (rows[0] && rows[0].name) out.name = rows[0].name;
    }
  } catch (e) { /* non-fatal */ }
  return out;
}

// Logs one row to public.usage_events for the admin cost/usage panel.
// Fail-open: a missing table or a blip just disappears into the console.
// Cost is estimated from Anthropic's published per-token pricing; the
// admin UI labels the figure as estimate-only.
async function recordUsageEvent(userId, usage) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !userId || !usage) return;
  try {
    const cost = estimateCostUSD(usage);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/usage_events`, {
      method: "POST",
      headers: {
        apikey:        SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer:        "return=minimal",
      },
      body: JSON.stringify({
        user_id:            userId,
        generation_type:    usage.generationType,
        model:              usage.model,
        input_tokens:       usage.input_tokens       || 0,
        output_tokens:      usage.output_tokens      || 0,
        cache_read_tokens:  usage.cache_read_tokens  || 0,
        cache_write_tokens: usage.cache_write_tokens || 0,
        est_cost_usd:       cost,
        // [COST 1] Truncation signal. truncated mirrors stop_reason ===
        // "max_tokens"; stop_reason is kept raw so future Anthropic values
        // (e.g. "pause_turn", "refusal") show up without a code change.
        truncated:          !!usage.truncated,
        stop_reason:        usage.stop_reason || null,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[usage_events] insert failed", res.status, text);
    }
  } catch (e) {
    console.warn("[usage_events] insert threw", e.message);
  }
}

// [PERF 3] SSE handler for streaming plan generation. Forwards Anthropic's
// SSE response chunks to the client as text deltas, then emits a trailing
// `meta` event carrying { cost, usage } once the upstream stream completes.
// Mirrors the side-effects of the non-streaming branch: writes usage_events,
// fires the first-plan + milestone emails. Returns the underlying Express
// response so the caller's `return` semantics still hold.
async function handleStreamingPlan({ res, payload, useCache, selectedModel, generationType, userId, creditCost, usedFreshTrends, trendsSnapshot }) {
  res.statusCode = 200;
  res.setHeader('Content-Type',  'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  // Disable proxy buffering so chunks reach the browser as they're written.
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  function sendEvent(eventName, dataObj) {
    res.write('event: ' + eventName + '\n');
    res.write('data: '  + JSON.stringify(dataObj) + '\n\n');
  }

  // One Anthropic streaming call: POSTs the payload, parses the SSE stream,
  // forwards text deltas to the client, and returns the accumulated usage +
  // stop_reason. Returns { errored: true } once any transport/upstream error
  // has already been signalled to the client; the caller should end the
  // response and not retry in that case.
  async function streamAnthropicOnce(currentPayload) {
    let anthropicRes;
    try {
      anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key':         ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type':      'application/json',
          accept:              'text/event-stream',
          ...(useCache ? { 'anthropic-beta': 'prompt-caching-2024-07-31' } : {}),
        },
        body: JSON.stringify({ ...currentPayload, stream: true }),
      });
    } catch (e) {
      sendEvent('error', { error: 'Could not reach AI provider: ' + (e.message || 'unknown') });
      return { errored: true };
    }

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text().catch(() => '');
      let parsed = null;
      try { parsed = JSON.parse(errBody); } catch (e) { /* keep raw */ }
      console.error('Anthropic error:', anthropicRes.status, parsed || errBody);
      sendEvent('error', {
        error: 'AI error ' + anthropicRes.status + ': ' + ((parsed && parsed.error && parsed.error.message) || 'Unknown'),
      });
      return { errored: true };
    }

    let inputTokens       = 0;
    let cacheReadTokens   = 0;
    let cacheWriteTokens  = 0;
    let outputTokens      = 0;
    let stopReason        = null;
    let fullText          = '';

    let sseBuf = '';
    const decoder = new TextDecoder('utf-8');
    const reader  = anthropicRes.body.getReader();

    function processSseEvent(rawEvent) {
      const lines = rawEvent.split('\n');
      let jsonStr = '';
      for (const line of lines) {
        if (line.startsWith('data: ')) jsonStr += line.slice(6);
        else if (line.startsWith('data:')) jsonStr += line.slice(5);
      }
      if (!jsonStr) return;
      let evt;
      try { evt = JSON.parse(jsonStr); } catch (e) { return; }
      const type = evt.type;
      if (type === 'message_start' && evt.message && evt.message.usage) {
        const u = evt.message.usage;
        inputTokens      = u.input_tokens                || 0;
        cacheReadTokens  = u.cache_read_input_tokens     || 0;
        cacheWriteTokens = u.cache_creation_input_tokens || 0;
        outputTokens     = u.output_tokens               || 0;
      } else if (type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
        const piece = evt.delta.text || '';
        if (piece) {
          fullText += piece;
          sendEvent('text', { delta: piece });
        }
      } else if (type === 'message_delta') {
        if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.usage && typeof evt.usage.output_tokens === 'number') {
          outputTokens = evt.usage.output_tokens;
        }
      }
    }

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = sseBuf.indexOf('\n\n')) >= 0) {
          const raw = sseBuf.slice(0, idx);
          sseBuf = sseBuf.slice(idx + 2);
          if (raw.trim()) processSseEvent(raw);
        }
      }
      if (sseBuf.trim()) processSseEvent(sseBuf);
    } catch (e) {
      console.error('Plan stream read error:', e.message);
      sendEvent('error', { error: 'Stream interrupted: ' + (e.message || 'unknown') });
      return { errored: true };
    }

    return {
      errored: false,
      stopReason,
      fullText,
      inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens,
    };
  }

  const first = await streamAnthropicOnce(payload);
  if (first.errored) { res.end(); return res; }

  let inputTokens      = first.inputTokens;
  let cacheReadTokens  = first.cacheReadTokens;
  let cacheWriteTokens = first.cacheWriteTokens;
  let outputTokens     = first.outputTokens;
  let stopReason       = first.stopReason;
  let retried          = false;

  // One-shot retry when Anthropic truncated on max_tokens. Tell the client
  // to discard the partial plan it streamed so far (event: reset clears the
  // progressive JSON parser + any rendered cards), then re-stream from
  // scratch at a larger budget. Sonnet 4.6's output ceiling is 64K, so 16K
  // is comfortably within bounds for the heaviest carousel/long_form plans.
  if (stopReason === 'max_tokens') {
    sendEvent('reset', {});
    const retryPayload = { ...payload, max_tokens: 16000 };
    const second = await streamAnthropicOnce(retryPayload);
    if (second.errored) { res.end(); return res; }
    retried = true;
    inputTokens      += second.inputTokens;
    cacheReadTokens  += second.cacheReadTokens;
    cacheWriteTokens += second.cacheWriteTokens;
    outputTokens     += second.outputTokens;
    stopReason        = second.stopReason;
  }

  const truncated = stopReason === 'max_tokens';

  // [COST 1] Tokens are summed across both attempts so usage_events records
  // what Anthropic actually billed, not just the final attempt.
  const usage = {
    generationType,
    model:              selectedModel,
    input_tokens:       inputTokens,
    output_tokens:      outputTokens,
    cache_read_tokens:  cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    truncated,
    stop_reason:        stopReason,
  };
  console.log('virl_usage', JSON.stringify(usage));
  recordUsageEvent(userId, usage).catch(() => {});

  const clientUsage = {
    outputTokens,
    cachedInputTokens:   cacheReadTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cacheReadTokens),
    cacheWriteTokens,
    truncated,
    stopReason,
    model:               selectedModel,
    retried,
  };

  // Fire-and-forget onboarding hooks, same as the non-streaming branch.
  maybeSendFirstPlanEmail(userId).catch(() => {});
  setTimeout(function () { maybeSendReferralMilestoneEmail(userId).catch(() => {}); }, 800);

  sendEvent('meta', {
    cost: creditCost,
    usage: clientUsage,
    usedFreshTrends: !!usedFreshTrends,
    trendsSnapshot:  trendsSnapshot || null,
  });
  res.end();
  return res;
}

const MILESTONE_THRESHOLDS = new Set([3, 7, 15]);

// Inline referral-milestone email. Counts the user's lifetime plan-type
// usage_events (recordUsageEvent has just inserted the current one) and
// fires the milestone email when the count is exactly 3, 7, or 15. Idempotent
// via email_sends dedupe — re-runs of any individual milestone are no-ops.
async function maybeSendReferralMilestoneEmail(userId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !userId) return;
  try {
    // Use Prefer: count=exact + HEAD to get a fast count without payload.
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/usage_events?user_id=eq.${userId}&generation_type=eq.plan&select=id`,
      {
        method: "HEAD",
        headers: {
          apikey:        SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          Prefer:        "count=exact",
        },
      }
    );
    if (!r.ok) return;
    const range = r.headers.get("content-range") || "";
    // content-range looks like "0-N/total" or "*/total"
    const totalStr = range.split("/")[1];
    const total = parseInt(totalStr, 10);
    if (Number.isNaN(total) || !MILESTONE_THRESHOLDS.has(total)) return;

    const ctx = await fetchUserContactForEmail(userId);
    if (!ctx.email) return;
    const tpl = referralMilestone({
      name: ctx.name,
      milestone: total,
      unsubscribeToken: makeUnsubToken(userId),
    });
    await sendEmail({
      userId,
      to:        ctx.email,
      template:  "referral_milestone",
      dedupeKey: `referral_milestone_${total}`,
      subject:   tpl.subject,
      html:      tpl.html,
      text:      tpl.text,
      marketing: false,
    });
  } catch (e) { /* non-fatal */ }
}

// Inline "first plan generated" send. Idempotent via the email_sends
// dedupe table — only the very first plan triggers the mail.
async function maybeSendFirstPlanEmail(userId) {
  const ctx = await fetchUserContactForEmail(userId);
  if (!ctx.email) return;
  const tpl = firstPlanGenerated({ name: ctx.name });
  await sendEmail({
    userId,
    to:        ctx.email,
    template:  "first_plan_generated",
    dedupeKey: "first_plan_generated",
    subject:   tpl.subject,
    html:      tpl.html,
    text:      tpl.text,
    marketing: false,
  });
}

// Atomically check both windows and record the request if both pass.
// Returns { ok: true } on success, { ok: false, kind: 'minute'|'hour' }
// when limited. Fails open on infra errors — a Supabase blip should never
// lock paying users out of the product.
async function checkChatRateLimit(userId) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_and_record_rate_limits`, {
      method: "POST",
      headers: {
        apikey:        SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_user_id:     userId,
        p_endpoint:    "chat",
        p_minute_max:  RATE_LIMIT_PER_MINUTE,
        p_hour_max:    RATE_LIMIT_PER_HOUR,
      }),
    });
    if (!res.ok) return { ok: true };
    const result = await res.json();
    if (result === "ok") return { ok: true };
    return { ok: false, kind: result };
  } catch (e) {
    return { ok: true };
  }
}

// Picks the platforms to fan inline Perplexity calls out over for each
// gen type. Keeps the request count small (see MAX_INLINE_PLATFORMS) so
// fresh-trends inline never balloons the per-call cost.
//   - plan / plan_partial:    user's selected platforms in this request
//   - caption:                the single platform being captioned
//   - scan_image / video:     user's profile.myPlatforms (no per-request
//                             platform list — scan is multi-platform by
//                             design). Empty → caller falls back to cached.
function pickInlinePlatforms(generationType, params, profile) {
  if (generationType === 'plan' || generationType === 'plan_partial') {
    return Array.isArray(params && params.platforms) ? params.platforms : [];
  }
  if (generationType === 'caption') {
    return (params && params.platform) ? [params.platform] : [];
  }
  if (generationType === 'scan_image' || generationType === 'scan_video_frame') {
    return Array.isArray(profile && profile.myPlatforms) ? profile.myPlatforms : [];
  }
  return [];
}

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
      // [INTEL 1] Personal-fact columns. Empty strings for existing users
      // who have not filled out these fields yet — the prompt builder skips
      // any falsy field so they simply don't appear in the system prompt.
      personalFacts:     data.personal_facts    || "",
      neverAssume:       data.never_assume      || "",
      loveToReference:   data.love_to_reference || "",
      // [INTEL 2] Per-platform format preferences. Defaults to {} so users
      // without any selections get an empty object and the prompt builder
      // skips the per-platform formats block entirely.
      platformFormats:   data.platform_formats  || {},
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
    // Client passes the parent plan's Perplexity snapshot back on regen
    // paths (plan_partial / plan_strategy / regen) so we don't re-bill the
    // user's fresh-trends allowance or fire a duplicate Perplexity call.
    // Untrusted input — validated by isValidTrendsSnapshot before use.
    trendsSnapshot: bodyTrendsSnapshot,
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

  // ── Rate limit (burst protection) ─────────────────────────────────────────
  // Runs before credit deduction + the Anthropic call so a flood is rejected
  // cheaply. The credit cap is still the wallet limit; these windows only
  // catch buggy clients and scripted abuse.
  const rate = await checkChatRateLimit(userId);
  if (!rate.ok) {
    if (rate.kind === "minute") {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({
        error: `Slow down — ${RATE_LIMIT_PER_MINUTE} generations per minute max. Try again in a moment.`,
      });
    }
    res.setHeader("Retry-After", "3600");
    return res.status(429).json({
      error: `You've hit ${RATE_LIMIT_PER_HOUR} generations this hour. Try again later.`,
    });
  }

  // ── Read credits row early (drives both trends decision + credit gate) ───
  // The fresh-trends allowance lives on the same row as `credits`, so we
  // pull both in one read and run the lazy weekly reset *before* deciding
  // whether this gen fires inline Perplexity. Without the early reset,
  // a user whose week just expired would see "0 remaining" right when
  // they should be back to 1.
  let plan = "free";
  let isPaid = false;
  let currentCredits = 0;
  let freshTrends = { plan: 0, scan: 0, caption: 0 };
  try {
    const credRes = await fetch(
      `${SUPABASE_URL}/rest/v1/credits?user_id=eq.${userId}`
      + `&select=plan,credits,reset_at,fresh_trends_plan_remaining,fresh_trends_scan_remaining,fresh_trends_caption_remaining`,
      { headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY } }
    );
    if (!credRes.ok) return res.status(500).json({ error: 'Could not verify credits.' });
    const [row] = await credRes.json();
    if (!row) return res.status(402).json({ error: 'Not enough credits this week.' });

    plan           = row.plan;
    isPaid         = PAID_PLANS.includes(plan);
    currentCredits = row.credits;
    // Columns default to 1 in the migration; coalesce here for the
    // pre-migration window where they may be null on existing rows.
    freshTrends = {
      plan:    row.fresh_trends_plan_remaining    == null ? 1 : row.fresh_trends_plan_remaining,
      scan:    row.fresh_trends_scan_remaining    == null ? 1 : row.fresh_trends_scan_remaining,
      caption: row.fresh_trends_caption_remaining == null ? 1 : row.fresh_trends_caption_remaining,
    };

    // Lazy weekly reset — day-count-based per user, not calendar Mondays.
    // Refills credits AND the three fresh-trends counters in one PATCH so
    // a user who signs up Wednesday gets a full Wednesday-to-Wednesday
    // refill on every wallet, not a partial half-week before Monday.
    const resetMs = row.reset_at ? Date.parse(row.reset_at) : NaN;
    const now     = Date.now();
    if (!row.reset_at || Number.isNaN(resetMs) || resetMs <= now) {
      const newCredits = isPaid ? 150 : 20;
      const newResetAt = new Date(now + 7 * 86400000).toISOString();
      await fetch(`${SUPABASE_URL}/rest/v1/credits?user_id=eq.${userId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'apikey':        SUPABASE_SERVICE_KEY,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal',
        },
        body: JSON.stringify({
          credits:                            newCredits,
          reset_at:                           newResetAt,
          fresh_trends_plan_remaining:        1,
          fresh_trends_scan_remaining:        1,
          fresh_trends_caption_remaining:     1,
        }),
      });
      currentCredits = newCredits;
      freshTrends = { plan: 1, scan: 1, caption: 1 };
    }

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
  } catch (e) {
    console.error('Credit check error:', e.message);
    return res.status(500).json({ error: 'Could not verify credits.' });
  }

  // ── Build the prompt server-side ──────────────────────────────────────────
  // Profile + vault patterns + playbook + cached trends all come from
  // Supabase, not the client, so the prompt template never has to be
  // exposed in the browser. Playbook = algorithm rules; trends = this
  // week's specifics. Both fetches fail open: missing data simply skips
  // that injection layer. Plan generation also pulls the last 3 weeks of
  // history so the LLM can build narratively week-over-week. Other
  // generation types skip history since they're scoped to a single piece
  // of content.
  const [profile, vaultPatterns, playbook, cachedTrends, history] = await Promise.all([
    fetchProfile(userId),
    generationType === "plan" ? fetchVaultPatterns(userId)                                                 : Promise.resolve(null),
    loadPlaybook(),
    loadLatestTrends(),
    generationType === "plan" ? loadPlanHistoryForPrompt(userId, 3, params && params.currentWeekStart)     : Promise.resolve([]),
  ]);

  // ── Decide trends source ─────────────────────────────────────────────────
  // Three paths, in priority order:
  //   1. Client-supplied snapshot (regen paths) → reuse, no Perplexity
  //      call, no allowance tick. plan_partial / plan_strategy / regen
  //      send the parent plan's `trendsSnapshot` so a single-card regen
  //      stays consistent with the rest of the plan.
  //   2. Inline fresh-trends → paid users always; free users when they
  //      still have an allowance for this gen type. Fires Perplexity per
  //      platform (capped by MAX_INLINE_PLATFORMS) and decrements the
  //      free-user counter after the upstream call succeeds.
  //   3. Cached cron trends → default fallback (up to 7 days old).
  let trends             = cachedTrends;
  let usedFreshTrends    = false;
  let trendsSnapshotEcho = null;
  const freshKey = FRESH_TRENDS_TYPE[generationType];

  if (bodyTrendsSnapshot != null && isValidTrendsSnapshot(bodyTrendsSnapshot)) {
    trends = bodyTrendsSnapshot;
    // Snapshot is a passthrough — the parent plan already paid for it.
  } else if (freshKey && (isPaid || freshTrends[freshKey] > 0)) {
    const inlinePlatforms = pickInlinePlatforms(generationType, params, profile);
    if (inlinePlatforms.length > 0) {
      const inline = await fetchInlineTrends(inlinePlatforms, cachedTrends);
      trends             = inline;
      usedFreshTrends    = true;
      trendsSnapshotEcho = inline;
    }
  }

  let built;
  try {
    built = dispatch(generationType, params, profile, vaultPatterns, playbook, trends, history);
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Bad request.' });
  }

  const selectedModel = ALLOWED_MODELS.includes(built.model) ? built.model : MODEL_SONNET;
  const creditCost    = built.cost || 1;

  // ── Credit cap + deduction (lazy reset already ran above) ────────────────
  try {
    if (!isPaid && currentCredits < creditCost) {
      return res.status(402).json({ error: 'Not enough credits this week.' });
    }
    // Founding + Pro skip credit deduction (unlimited within the tier).
    // Standard + free pay per-generation. Mirrors prior behavior.
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
    // Decrement the fresh-trends counter for free users that just
    // consumed their freebie. Paid users skip — they have no cap.
    // Fire-and-forget; the upstream call has not run yet but we
    // accept the small risk of "charged but no result" over the
    // alternative of "result but no charge" if Anthropic fails after
    // this PATCH lands. The wallet stays consistent with credits.
    if (usedFreshTrends && !isPaid && freshKey) {
      const counterCol = FRESH_TRENDS_COLUMNS[freshKey];
      const nextVal    = Math.max(0, freshTrends[freshKey] - 1);
      fetch(`${SUPABASE_URL}/rest/v1/credits?user_id=eq.${userId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'apikey': SUPABASE_SERVICE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ [counterCol]: nextVal }),
      }).catch(() => {});
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

    // [DATE-FIX] Prepend the user's local date to the (uncached) userPrompt so
    // every generation type — captions, plans, scripts, scans — has the real
    // current year + month + day + weekday. Models default to their
    // training-era guess otherwise (e.g. captions referencing "2024" or
    // "January" mid-year-2026). Lives in the userPrompt instead of the
    // cached systemPrompt to avoid invalidating the per-user prompt cache
    // once per day. Spelling out month name, ordinal day, and weekday in
    // prose form gives the model multiple natural-language anchors instead
    // of relying on it to parse an ISO string.
    const WEEKDAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const ordinal = (n) => {
      const s = ["th","st","nd","rd"];
      const v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    };
    const cn = params && params.clientNow;
    let nowLine;
    if (cn && cn.iso && typeof cn.weekday === "number" && cn.weekday >= 0 && cn.weekday <= 6) {
      const parts = String(cn.iso).split("-");
      const yr = parseInt(parts[0], 10) || cn.year || new Date().getUTCFullYear();
      const mo = parseInt(parts[1], 10) || 1;
      const dy = parseInt(parts[2], 10) || 1;
      const monthName = MONTH_NAMES[mo - 1] || "";
      const wday = WEEKDAY_NAMES[cn.weekday];
      nowLine = "TODAY'S DATE: " + cn.iso + " (" + wday + ", " + monthName + " " + ordinal(dy) + ", " + yr + "). The current year is " + yr + ", the current month is " + monthName + ", and today is the " + ordinal(dy) + ". Any reference in your output to the current date, year, month, day of the month, or day of the week — including phrases like 'this year', 'this month', 'today', 'right now', or seasonal/holiday timing — must be consistent with this. Never refer to a past year, month, or date as the current one.";
    } else {
      const sNow = new Date();
      const yr = sNow.getUTCFullYear();
      const mo = sNow.getUTCMonth() + 1;
      const dy = sNow.getUTCDate();
      const sIso = yr + "-" + String(mo).padStart(2,"0") + "-" + String(dy).padStart(2,"0");
      const monthName = MONTH_NAMES[mo - 1];
      nowLine = "TODAY'S DATE: " + sIso + " (" + WEEKDAY_NAMES[sNow.getUTCDay()] + ", " + monthName + " " + ordinal(dy) + ", " + yr + " UTC). The current year is " + yr + ", the current month is " + monthName + ", and today is the " + ordinal(dy) + ". Any reference in your output to the current date, year, month, day of the month, or day of the week — including phrases like 'this year', 'this month', 'today', 'right now', or seasonal/holiday timing — must be consistent with this. Never refer to a past year, month, or date as the current one.";
    }

    const content = [];
    if (imageBase64 && imageType) {
      content.push({ type: 'image', source: { type: 'base64', media_type: imageType, data: imageBase64 } });
    }
    content.push({ type: 'text', text: nowLine + "\n\n" + built.userPrompt });

    const payload = {
      model:      selectedModel,
      max_tokens: built.maxTokens || 1000,
      messages:   [{ role: 'user', content }],
      ...(systemBlock ? { system: systemBlock } : {}),
    };

    // [PERF 3] Plan generations stream so the client can render strategy and
    // cards progressively. Same total time, ~half the perceived wait. Other
    // generation types stay non-streaming because they're short enough that
    // streaming adds complexity without changing user experience.
    // plan_partial reuses the same streaming pipeline so it inherits the
    // truncation retry path for free; the client opts the parser into
    // partial mode (cards-only output, no strategy/stats).
    if (generationType === 'plan' || generationType === 'plan_partial') {
      return await handleStreamingPlan({
        res, payload, useCache, selectedModel, generationType,
        userId, creditCost,
        usedFreshTrends, trendsSnapshot: trendsSnapshotEcho,
      });
    }

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

    // [COST 1] Truncation flag derived from Anthropic's stop_reason. Captured
    // here so it lands on both the usage_events row (admin trends) and the
    // response payload (per-event client telemetry).
    const stopReason = data.stop_reason || null;
    const truncated  = stopReason === 'max_tokens';

    let clientUsage = null;
    if (data.usage) {
      const usage = {
        generationType,
        model:               selectedModel,
        input_tokens:        data.usage.input_tokens        || 0,
        output_tokens:       data.usage.output_tokens       || 0,
        cache_read_tokens:   data.usage.cache_read_input_tokens     || 0,
        cache_write_tokens:  data.usage.cache_creation_input_tokens || 0,
        truncated,
        stop_reason:         stopReason,
      };
      console.log('virl_usage', JSON.stringify(usage));
      // Fire-and-forget insert so admin Dashboard can trend cost/usage.
      // Failure is logged inside the helper; we never wait on it.
      recordUsageEvent(userId, usage).catch(() => {});
      // [COST 1] Surfaced to the client so existing logEvent payloads can
      // forward per-generation cost/cache/truncation signal into events.
      // Cache-read tokens are billed at ~10% of normal input; uncached is the
      // remainder of input_tokens. Derived here once so callers don't repeat it.
      clientUsage = {
        outputTokens:        usage.output_tokens,
        cachedInputTokens:   usage.cache_read_tokens,
        uncachedInputTokens: Math.max(0, usage.input_tokens - usage.cache_read_tokens),
        cacheWriteTokens:    usage.cache_write_tokens,
        truncated,
        stopReason,
        model:               selectedModel,
      };
    }

    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');

    // Fire-and-forget first-plan onboarding email. The send wrapper's
    // dedupe table makes this idempotent — only the very first plan a
    // user generates triggers the mail; every subsequent plan is a no-op.
    if (generationType === "plan") {
      maybeSendFirstPlanEmail(userId).catch(() => {});
      // Milestone email fires after the usage_event row has had a moment
      // to land — small setTimeout so the count read sees this generation.
      setTimeout(function(){ maybeSendReferralMilestoneEmail(userId).catch(() => {}); }, 800);
    }

    // `cost` flows back so the client can do an optimistic credit-counter
    // tick without needing to know the cost table itself. `usage` (added by
    // [COST 1]) is forwarded into per-generation logEvent payloads on the
    // client so we can trend output size, cache hit ratio, and truncation
    // rate alongside business metadata. `usedFreshTrends` lets the client
    // show the post-action "✦ Fresh trends — this plan" banner + per-card
    // badges. `trendsSnapshot` is echoed so the client can persist it on
    // its plan/result row and pass it back on a future regen.
    return res.status(200).json({
      text,
      cost: creditCost,
      usage: clientUsage,
      usedFreshTrends,
      trendsSnapshot: trendsSnapshotEcho,
    });

  } catch (e) {
    console.error('Generation error:', e.message);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}
