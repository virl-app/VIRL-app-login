import {
  dispatch,
  isValidGenerationType,
  requiresImage,
  ALLOWED_MODELS,
  MODEL_SONNET,
} from "./_lib/prompts.js";
import { loadPlaybook }              from "./_lib/playbook.js";
import { loadLatestTrends }          from "./_lib/trends.js";
import { loadComplianceRules, getComplianceForNiche, scrubCompliance } from "./_lib/compliance.js";
import { fetchInlineTrends, isValidTrendsSnapshot } from "./_lib/fresh-trends-inline.js";
import { loadPlanHistoryForPrompt }  from "./_lib/plan-history.js";
import { fetchRecentEdits }          from "./_lib/edit-examples.js";
import { sendEmail }                 from "./_lib/email-send.js";
import { firstPlanGenerated, referralMilestone } from "./_lib/email-templates.js";
import { makeUnsubToken }            from "./_lib/unsub-token.js";
import { estimateCostUSD }           from "./_lib/pricing.js";
import { sendLoopsEvent, sendLoopsEventOnce } from "./_lib/loops.js";
import { fetchHandleResearch }       from "./_lib/handle-research.js";
import { computeVoiceDrift, extractVoiceText } from "./_lib/voice-drift.js";
import { selectVaultExemplars, exemplarsAsVoiceText } from "./_lib/vault-exemplars.js";

// [EMAIL-CUTOVER] Feature flag controlling whether milestone sends route
// through Loops (new) or Resend (legacy). Flip to "true" in Vercel env
// once Cowork's Loops automations are enabled and verified.
const EMAIL_VIA_LOOPS = process.env.EMAIL_VIA_LOOPS === "true";

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

// [VOICE-DRIFT] Build the reference corpus the drift telemetry compares
// generated output against. Combines (in order of voice-fidelity weight):
//   1. sample_caption — the canonical "this is how I sound" caption
//   2. voice_samples — optional additional captions the user added
//   3. handlePostExcerpts — verbatim excerpts Perplexity pulled from their
//      actual indexed posts (may be empty for small / unindexed creators)
//   4. vaultExemplars — hooks + descriptions of items the user saved
//      and/or posted (the same few-shot pool fed into the generation
//      prompt; richest first-party signal we have)
// Returns "" when no source is available; the caller skips telemetry in
// that case. Each source is separated by blank lines so featurize() sees
// distinct sentences rather than concatenated runs.
function buildVoiceReference(profile, vaultExemplars) {
  const parts = [];
  if (profile && profile.sampleCaption && typeof profile.sampleCaption === "string") {
    parts.push(profile.sampleCaption.trim());
  }
  if (profile && Array.isArray(profile.voiceSamples)) {
    for (const s of profile.voiceSamples) {
      if (typeof s === "string" && s.trim()) parts.push(s.trim());
    }
  }
  if (profile && Array.isArray(profile.handlePostExcerpts)) {
    for (const s of profile.handlePostExcerpts) {
      if (typeof s === "string" && s.trim()) parts.push(s.trim());
    }
  }
  const exemplarText = exemplarsAsVoiceText(vaultExemplars);
  if (exemplarText) parts.push(exemplarText);
  return parts.join("\n\n");
}

// [PERF 3] SSE handler for streaming plan generation. Forwards Anthropic's
// SSE response chunks to the client as text deltas, then emits a trailing
// `meta` event carrying { cost, usage } once the upstream stream completes.
// Mirrors the side-effects of the non-streaming branch: writes usage_events,
// fires the first-plan + milestone emails. Returns the underlying Express
// response so the caller's `return` semantics still hold.
async function handleStreamingPlan({ res, payload, useCache, selectedModel, generationType, userId, creditCost, usedFreshTrends, trendsSnapshot, complianceForNiche, voiceReference }) {
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
  // [COMPLIANCE 1] Track the final, complete model output for the
  // post-stream scrub. On retry the first attempt's text is discarded
  // (client got the `reset` event); the second attempt's text is the
  // canonical output. Without retry, first.fullText is canonical.
  let finalText        = first.fullText;

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
    finalText         = second.fullText;
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
  // [STABILITY] Await recordUsageEvent so the milestone email's
  // plan-count query (in maybeSendReferralMilestoneEmail below) sees
  // THIS generation. Previously fire-and-forget — the count race had
  // been "mitigated" by a setTimeout(800ms) before the milestone send,
  // but Vercel's serverless function terminates after the response
  // returns and the setTimeout's callback reliably never fires. Net
  // effect: the 3 / 7 / 15-plan referral milestone email has been
  // functionally dead in production.
  try { await recordUsageEvent(userId, usage); } catch (e) { /* logged inside helper */ }

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

  // Onboarding hooks. First-plan email is independent of plan count so
  // stays fire-and-forget. Milestone email is awaited (not setTimeout)
  // so the function container stays alive for the actual Resend send;
  // the prior setTimeout approach silently dropped sends in production.
  maybeSendFirstPlanEmail(userId).catch(() => {});
  try { await maybeSendReferralMilestoneEmail(userId); } catch (e) { /* non-fatal — logged inside */ }

  // [COMPLIANCE 1] Post-stream scrub. Parse the accumulated final text,
  // run the niche's denylist, and emit any flags / scrubbed payload to the
  // client via a `compliance` event. The progressive text already streamed
  // to the client stays as-is (rewrites are advisory for streaming paths
  // in v1 — see api/_lib/compliance.js header for the rationale). Wrapped
  // in try/catch so a malformed model output (truncated mid-JSON, etc.)
  // never blocks the `meta` event or the response close.
  if (complianceForNiche) {
    try {
      const parsed = finalText ? JSON.parse(finalText) : null;
      if (parsed) {
        const { scrubbed, flags } = scrubCompliance(complianceForNiche, parsed);
        if (flags.length > 0) {
          console.log('virl_compliance', JSON.stringify({
            generationType,
            niche:        complianceForNiche.nicheKey,
            locale:       complianceForNiche.locale,
            flag_count:   flags.length,
            rewritten:    flags.filter(f => f.rewritten).length,
          }));
          sendEvent('compliance', {
            flags,
            // Stringify the scrubbed payload so a future client that opts
            // into "use scrubbed text" can swap it in atomically. v1
            // clients ignore unknown events, so this is forward-compatible
            // wire data without any UI work.
            scrubbed: JSON.stringify(scrubbed),
          });
        }
      }
    } catch (e) {
      // JSON.parse failure on a streamed plan is not actionable here —
      // the client's progressive parser has the same input and produces
      // user-facing error UI if it can't parse. Log once and continue.
      console.warn('[compliance] post-stream scrub skipped:', e.message);
    }
  }

  // [VOICE-DRIFT] Stylometric distance between this generation and the
  // user's combined voice reference (sample_caption + voice_samples +
  // handlePostExcerpts). Skipped when there's no reference, the JSON didn't
  // parse, or either side is too thin to featurize. Logged-only — no
  // client-visible signal — so a failure here must never block the meta
  // event or response close.
  if (voiceReference && finalText) {
    try {
      const parsedForDrift = JSON.parse(finalText);
      const voiceText = extractVoiceText(parsedForDrift);
      const drift = computeVoiceDrift(voiceText, voiceReference);
      if (drift) {
        console.log('virl_voice_drift', JSON.stringify({
          generationType,
          model:     selectedModel,
          score:     drift.score,
          ref_words: drift.ref.wordCount,
          gen_words: drift.gen.wordCount,
          deltas:    drift.deltas,
        }));
      }
    } catch (e) {
      // Same swallow rationale as compliance above — JSON parse failure here
      // surfaces as the existing client-side error UI; telemetry stays quiet.
    }
  }

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
// dedupe table (legacy Resend path) or Loops's per-contact event dedupe
// (Loops path) — only the very first plan triggers the mail.
async function maybeSendFirstPlanEmail(userId) {
  const ctx = await fetchUserContactForEmail(userId);
  if (!ctx.email) return;

  // [EMAIL-CUTOVER] When EMAIL_VIA_LOOPS=true, fire a `firstPlanGenerated`
  // Loops event and let Cowork's Loops automation handle the send. Loops
  // dedupes the event per contact so retries are safe. When the flag is
  // off, fall back to the original Resend path.
  //
  // [LOOPS-EVENT-NAME] Event name is camelCase to match Loops's convention
  // and the existing precedent in api/cron/email-triggers.js (which fires
  // `thirtyDayMilestone`). Cowork's `first_plan_celebrated` Loop in the
  // Loops dashboard is wired to listen for this exact name.
  if (EMAIL_VIA_LOOPS) {
    // [LOOPS-DEDUPE] One-shot per user. Without dedupe, a user generating
    // their 2nd plan (or any subsequent plan if the client-side flag was
    // wiped) would re-fire firstPlanGenerated and Cowork's Loop would
    // send the welcome again unless Loops dashboard dedupe is on. The
    // email_sends claim makes this resilient to that config gap.
    await sendLoopsEventOnce({
      userId,
      email:     ctx.email,
      eventName: "firstPlanGenerated",
      properties: { firstName: ctx.name || "" },
      dedupeKey: "firstPlanGenerated",
    });
    return;
  }

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

// Per-user vault summary used to ground voice-producing generations. Returns
// both the aggregate "patterns" (count + top platform/format the plan
// builder has always used) AND `exemplars` — up to 5 actual saved/posted
// items used as few-shot voice examples in the prompt. Single DB read
// regardless of how many fields callers need.
async function fetchVaultPatterns(userId) {
  const empty = { count: 0, topPlatform: null, topFormat: null, exemplars: [] };
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${userId}&select=vault,results`,
      { headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY } }
    );
    if (!res.ok) return empty;
    const rows = await res.json();
    const vault   = (rows[0] && rows[0].vault)   || [];
    const results = (rows[0] && rows[0].results) || [];

    // [VAULT-EXEMPLARS] Few-shot pool: most recent items the user saved or
    // posted, joined and ranked in vault-exemplars.js. Returned alongside
    // the aggregate patterns so the prompt builder can use either or both.
    // count=5 matches the product decision (richer corpus than 3, still
    // well under the token budget).
    const exemplars = selectVaultExemplars(vault, results, 5);

    const planItems = vault.filter(v => v && v.type === "plan");
    if (!planItems.length) {
      // No plan-vault items, but exemplars may still exist if the user
      // logged results on plan cards without saving them. Surface those
      // for the few-shot path even though the patterns block stays empty.
      return { count: 0, topPlatform: null, topFormat: null, exemplars };
    }
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
    return {
      count:       planItems.length,
      topPlatform: top(platformCounts),
      topFormat:   top(formatCounts),
      exemplars,
    };
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
      // [LEARN-FROM-EDITS] Opt-in flag — when true the plan builder is
      // allowed to fetch + inject recent edit diffs as voice examples.
      // False on existing rows where the column isn't yet populated.
      learnFromEdits:        !!data.learn_from_edits,
      // [LEARNING-CONSENT] Three additional opt-in flags added by migration
      // 010. All default false on pre-migration rows. Server-side gates
      // below use these to decide whether to use the corresponding learning
      // signal in the prompt / API call.
      learnFromVault:        !!data.learn_from_vault,
      learnFromResults:      !!data.learn_from_results,
      learnFromPublicPosts:  !!data.learn_from_public_posts,
      // [VOICE-REFERENCE] Optional additional caption samples beyond the
      // primary sample_caption field. Empty array on pre-migration rows.
      // Used by voice-drift.js to enrich the reference corpus when the
      // single sample_caption would otherwise be too thin.
      voiceSamples:      Array.isArray(data.voice_samples) ? data.voice_samples : [],
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
      + `&select=plan,credits,reset_at,fresh_trends_plan_remaining,fresh_trends_scan_remaining,fresh_trends_caption_remaining,comp_weekly_credits,comp_expires_at`,
      { headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY } }
    );
    if (!credRes.ok) return res.status(500).json({ error: 'Could not verify credits.' });
    const [row] = await credRes.json();
    if (!row) return res.status(402).json({ error: 'Not enough credits this week.' });

    plan           = row.plan;
    isPaid         = PAID_PLANS.includes(plan);
    currentCredits = row.credits;

    // [COMP] Tester comp — a time-boxed per-user weekly-allowance override that
    // is independent of plan/tier/Stripe (see migrations/012). While live, the
    // user gets comp_weekly_credits/week and bypasses the free-trial day cap.
    // It self-reverts: once comp_expires_at passes, the refill below and the
    // trial gate fall back to the normal plan-derived behavior with no cleanup.
    const compExpiresMs = row.comp_expires_at ? Date.parse(row.comp_expires_at) : NaN;
    const compActive    = !Number.isNaN(compExpiresMs)
      && compExpiresMs > Date.now()
      && row.comp_weekly_credits != null;
    const compAllowance = compActive ? row.comp_weekly_credits : null;
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
      // [COMP] comp allowance wins while live; otherwise plan-derived default.
      const newCredits = compActive ? compAllowance : (isPaid ? 150 : 20);
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
    if (!isPaid && !compActive && createdAt) {
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
  // [VAULT-EXEMPLARS] Fetch vault patterns for any voice-producing
  // generation type — plan still uses the aggregate counts; caption,
  // caption_remix, script, plan_partial, plan_strategy use the few-shot
  // exemplars. Scan types (image/video frame) don't generate creator
  // voice and don't need either, so they still skip the read.
  const VOICE_GEN_TYPES = new Set([
    "plan", "plan_partial", "plan_strategy",
    "caption", "caption_remix", "script",
  ]);
  const [profile, vaultPatterns, playbook, cachedTrends, history, complianceRules] = await Promise.all([
    fetchProfile(userId),
    VOICE_GEN_TYPES.has(generationType) ? fetchVaultPatterns(userId)                                          : Promise.resolve(null),
    loadPlaybook(),
    loadLatestTrends(),
    generationType === "plan" ? loadPlanHistoryForPrompt(userId, 3, params && params.currentWeekStart)     : Promise.resolve([]),
    // [COMPLIANCE 1] Per-niche compliance rules (Real Estate, Wellness in
    // v1). Loader returns {} on any infra failure so the get-for-niche
    // call below falls through to the hardcoded safe-defaults floor.
    loadComplianceRules(),
  ]);

  // [LEARNING-CONSENT] Apply consent gates AFTER vault data is fetched so
  // we can post-process without restructuring the parallel fetch. The
  // data is loaded regardless of consent (small DB read), but signals
  // derived from it are stripped before they reach the prompt builder.
  //
  //   learn_from_vault OFF:    null out gatedVaultPatterns entirely — no
  //                            count, no platform/format aggregates, no
  //                            exemplars reach the prompt or drift ref.
  //   learn_from_results OFF:  keep vault-derived exemplars but strip the
  //                            results-derived signals (result-only items
  //                            removed; "both" source demoted to "vault";
  //                            performanceTag cleared).
  //
  // The Perplexity research call upstream is already gated on
  // learn_from_public_posts; nothing to scrub here for that signal.
  let gatedVaultPatterns = vaultPatterns;
  if (profile && !profile.learnFromVault) {
    gatedVaultPatterns = null;
  } else if (gatedVaultPatterns && Array.isArray(gatedVaultPatterns.exemplars) && !(profile && profile.learnFromResults)) {
    gatedVaultPatterns = Object.assign({}, gatedVaultPatterns, {
      exemplars: gatedVaultPatterns.exemplars
        .filter(function(e){ return e && e.source !== "result"; })
        .map(function(e){
          return Object.assign({}, e, {
            source:         e.source === "both" ? "vault" : e.source,
            performanceTag: null,
          });
        }),
    });
  }

  // [COMPLIANCE 1] Resolve the effective compliance bundle once per
  // request. Niche comes from params (plan/plan_partial pass it explicitly;
  // for other gen types the client injects it from localStorage — see the
  // patches to callAPI / consumePlanStream in index.html). Locale defaults
  // to "US" until a per-user country field ships; non-US locales no-op.
  const complianceForNiche = getComplianceForNiche(complianceRules, params && params.niche, "US");

  // [LEARN-FROM-EDITS] Fetch the user's recent edit diffs as voice
  // examples — but only when they're opted in (profile.learnFromEdits).
  // Sequential after profile load (rather than parallelized into the
  // Promise.all above) because we need to read the opt-in flag first;
  // the alternative would be to over-fetch on every plan generation
  // for users who haven't enabled the feature. The hit on opted-in
  // users is one indexed events query (~50-100ms), acceptable.
  //
  // Applies to every generation type that produces user-facing copy:
  //   - plan, plan_partial:           full + partial plan generation
  //   - caption, caption_remix:       caption tab
  //   - scan_image, scan_video_frame: scan tab
  //
  // Skipped intentionally:
  //   - plan_strategy: regens the strategic thesis only, not card
  //     content — voice diffs don't inform "what angle should this
  //     week take." Including them would add noise.
  //   - script: long-form video scripts have their own structure
  //     that doesn't map cleanly to short before/after card diffs.
  const EDIT_LEARNING_TYPES = new Set([
    "plan", "plan_partial",
    "caption", "caption_remix",
    "scan_image", "scan_video_frame",
  ]);
  const recentEdits = (EDIT_LEARNING_TYPES.has(generationType) && profile && profile.learnFromEdits)
    ? await fetchRecentEdits(userId)
    : [];

  // [HANDLE-RESEARCH] Pull a Perplexity-sourced summary of the creator's
  // actual posting patterns across their connected social handles. Cached
  // 30 days in creator_handle_research; refreshes on handle change. Attached
  // to the profile object so prompts.js buildProfileCtx can inject it as
  // additional creator context without changing dispatch's signature.
  // Fail-open: returns null on any infrastructure / Perplexity error and
  // the rest of the generation still works exactly as before.
  // [LEARNING-CONSENT] Gate the Perplexity handle research on the
  // learn_from_public_posts opt-in. Without consent we skip the API
  // call entirely — no third-party request fires and no excerpts are
  // cached. Existing cached research from before the user revoked
  // consent stays in the row but is forward-looking ignored (the row
  // gets refreshed-with-empty on next opt-in cache miss).
  if (profile && profile.handles && profile.learnFromPublicPosts) {
    try {
      // [STABILITY] Race the research call against a 2s timeout so a
      // cold-cache Perplexity round-trip can't extend the chat.js
      // critical path past Vercel's function limit. The losing promise
      // (the Perplexity call) isn't cancelled — Vercel typically keeps
      // the function alive until res.end(), so the background fetch
      // often completes and writes to cache anyway, warming subsequent
      // calls. The prewarm endpoint on profile save is the steady-state
      // path; this timeout protects the rare cold-cache chat call.
      const research = await Promise.race([
        fetchHandleResearch(userId, profile.handles, profile.inspiration),
        new Promise(function(resolve){ setTimeout(function(){ resolve(null); }, 2000); }),
      ]);
      if (research) {
        // researchText is the descriptive paragraph that prompts.js injects
        // as "Observed posting pattern: ..." — same shape it's always been.
        // postExcerpts is verbatim caption text from the user's actual
        // indexed posts, used as additional voice-drift reference.
        profile.handleResearch     = research.researchText;
        profile.handlePostExcerpts = research.postExcerpts || [];
      }
    } catch (e) { /* non-fatal — generation continues without research */ }
  }

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
    built = dispatch(generationType, params, profile, gatedVaultPatterns, playbook, trends, history, recentEdits, complianceForNiche);
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Bad request.' });
  }

  const selectedModel = ALLOWED_MODELS.includes(built.model) ? built.model : MODEL_SONNET;
  const creditCost    = built.cost || 1;

  // ── Credit cap + deduction (lazy reset already ran above) ────────────────
  try {
    // [ATOMIC-CREDITS] Atomic check-and-decrement via the consume_credit RPC.
    // The previous pattern read currentCredits then PATCHed credits separately;
    // two parallel requests with currentCredits=1 both wrote credits=0 and
    // both got their generation. The RPC's WHERE clause + Postgres row lock
    // serializes concurrent callers so only one wins.
    //
    // [PRICING credit-model] Only Pro is unlimited. Founder Circle
    // ('founding') now meters at 150/week like Standard — credits
    // decrement per generation and refill on the weekly reset. Free
    // users pay per-generation too. The strict path returns NULL when
    // insufficient → 402; lenient (paid non-Pro) always succeeds and
    // floors at 0.
    if (plan !== 'pro') {
      const strict = !isPaid; // free + trial = hard balance check; paid non-Pro = floor at 0
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/consume_credit`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'apikey': SUPABASE_SERVICE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_user_id: userId,
          p_cost:    creditCost,
          p_strict:  strict,
        }),
      });
      if (!rpcRes.ok) {
        const errBody = await rpcRes.text().catch(() => '');
        console.error('[chat] consume_credit RPC failed:', rpcRes.status, errBody);
        return res.status(500).json({ error: 'Could not verify credits.' });
      }
      // RPC returns the new balance, or null if strict mode rejected
      // for insufficient credits (or row missing). PostgREST wraps a
      // scalar return in the response body directly — we parse and
      // check for null.
      const newBalance = await rpcRes.json().catch(() => null);
      if (strict && newBalance === null) {
        return res.status(402).json({ error: 'Not enough credits this week.' });
      }
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
    // [CACHE-TIER] Two-breakpoint prompt caching.
    //
    // builds return systemPrompt as either:
    //   - { shared, perUser } — new two-tier format. shared content
    //     (role + GUARD + LOCALE + STYLE_GUARD + schema + per-niche
    //     compliance) is cached across ALL users + ALL generation types
    //     per role. perUser content (critical facts + profileCtx +
    //     vaultCtx) is cached per user.
    //   - string — legacy single-tier format (back-compat for any
    //     builder not yet refactored). Single cache breakpoint, same
    //     as before.
    //
    // The shared tier is the big win: a free user generating their first
    // plan still pays the cache write, but every other user's request
    // hits the cache. Cache read ratio jumps from ~4% to 60-80%+.
    //
    // Cache invalidation: shared tier invalidates only when the prompt
    // STRUCTURE changes (rare — code deploys). Per-user tier invalidates
    // on profile save, vault save, or handle-research refresh.
    //
    // The beta header is required to enable caching.
    const sp = built.systemPrompt;
    let systemBlock;
    if (sp && typeof sp === 'object' && (sp.shared || sp.perUser)) {
      const tiers = [];
      if (sp.shared && String(sp.shared).trim()) {
        tiers.push({
          type: 'text',
          text: sp.shared,
          cache_control: { type: 'ephemeral' },
        });
      }
      if (sp.perUser && String(sp.perUser).trim()) {
        tiers.push({
          type: 'text',
          text: sp.perUser,
          cache_control: { type: 'ephemeral' },
        });
      }
      if (tiers.length > 0) systemBlock = tiers;
    } else if (typeof sp === 'string' && sp.trim()) {
      systemBlock = [{
        type: 'text',
        text: sp,
        cache_control: { type: 'ephemeral' },
      }];
    }
    const useCache = !!systemBlock;

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
        complianceForNiche,
        voiceReference: buildVoiceReference(profile, gatedVaultPatterns && gatedVaultPatterns.exemplars),
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
      // [STABILITY] Awaited (was fire-and-forget) so the milestone email
      // path below sees the just-inserted row when it counts plans. See
      // identical comment in the streaming branch.
      try { await recordUsageEvent(userId, usage); } catch (e) { /* logged inside helper */ }
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

    let text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');

    // [COMPLIANCE 1] Post-generation scrub for non-streaming gen types
    // (script, caption, caption_remix, scan_image, scan_video_frame). The
    // model output here is the full JSON in one shot, so we can safely
    // re-stringify the scrubbed payload back into the `text` field. Plan +
    // plan_partial go through handleStreamingPlan and scrub there instead.
    // Failures here are non-fatal: if the model returned non-JSON or the
    // walker throws, we surface the original text — the client's
    // extractJSON handles weird responses with its own error UI.
    let complianceFlags = [];
    if (complianceForNiche) {
      try {
        const parsedOutput = JSON.parse(text);
        const { scrubbed, flags } = scrubCompliance(complianceForNiche, parsedOutput);
        complianceFlags = flags;
        if (flags.length > 0) {
          console.log('virl_compliance', JSON.stringify({
            generationType,
            niche:      complianceForNiche.nicheKey,
            locale:     complianceForNiche.locale,
            flag_count: flags.length,
            rewritten:  flags.filter(f => f.rewritten).length,
          }));
          text = JSON.stringify(scrubbed);
        }
      } catch (e) {
        // Malformed JSON from the model — let the original text pass
        // through so the existing extractJSON fallback in index.html can
        // try to recover. Scrub does not run in that case.
      }
    }

    // [VOICE-DRIFT] Mirrors the streaming-path block. Independent parse so a
    // compliance-disabled niche still gets telemetry, and a malformed JSON
    // payload here stays silent (the original `text` is returned untouched
    // and the client's extractJSON deals with recovery).
    const voiceReference = buildVoiceReference(profile, gatedVaultPatterns && gatedVaultPatterns.exemplars);
    if (voiceReference && text) {
      try {
        const parsedForDrift = JSON.parse(text);
        const voiceText = extractVoiceText(parsedForDrift);
        const drift = computeVoiceDrift(voiceText, voiceReference);
        if (drift) {
          console.log('virl_voice_drift', JSON.stringify({
            generationType,
            model:     selectedModel,
            score:     drift.score,
            ref_words: drift.ref.wordCount,
            gen_words: drift.gen.wordCount,
            deltas:    drift.deltas,
          }));
        }
      } catch (e) { /* telemetry-only; silent failure by design */ }
    }

    // Fire-and-forget first-plan onboarding email. The send wrapper's
    // dedupe table makes this idempotent — only the very first plan a
    // user generates triggers the mail; every subsequent plan is a no-op.
    if (generationType === "plan") {
      maybeSendFirstPlanEmail(userId).catch(() => {});
      // [STABILITY] Awaited milestone send. The previous setTimeout(800ms)
      // approach was scheduled then immediately ended the response; Vercel
      // terminates the function container before the timer fires, so the
      // milestone email never actually sent in production. recordUsageEvent
      // above is now awaited too, so the count query sees this generation.
      try { await maybeSendReferralMilestoneEmail(userId); } catch (e) { /* non-fatal */ }
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
      // [COMPLIANCE 1] Forwarded to the client so future UI work can
      // surface flags as a "review before posting" badge. Empty array
      // for any out-of-scope niche / non-US locale / no-violations
      // response. v1 client ignores the field — wire-only for now.
      complianceFlags,
    });

  } catch (e) {
    console.error('Generation error:', e.message);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}
