// [PR1] Shared telemetry writers for endpoints outside api/chat.js (which
// keeps its own inline copies with the extra drift columns). Both fail open.

import { estimateCostUSD } from "./pricing.js";

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function headers() {
  return {
    apikey:        SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    Prefer:        "return=minimal",
  };
}

// usage: { generationType, model, usage: <anthropic usage object>, stopReason }
export async function recordUsage(userId, { generationType, model, usage, stopReason }) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !userId) return;
  const u = usage || {};
  const row = {
    generationType,
    model,
    input_tokens:       u.input_tokens                || 0,
    output_tokens:      u.output_tokens               || 0,
    cache_read_tokens:  u.cache_read_input_tokens     || 0,
    cache_write_tokens: u.cache_creation_input_tokens || 0,
  };
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/usage_events`, {
      method: "POST", headers: headers(),
      body: JSON.stringify({
        user_id:            userId,
        generation_type:    generationType,
        model:              model,
        input_tokens:       row.input_tokens,
        output_tokens:      row.output_tokens,
        cache_read_tokens:  row.cache_read_tokens,
        cache_write_tokens: row.cache_write_tokens,
        est_cost_usd:       estimateCostUSD(row),
        truncated:          stopReason === "max_tokens",
        stop_reason:        stopReason || null,
      }),
    });
  } catch (e) { console.warn("[usage] insert threw", e.message); }
}

// Product telemetry, same table the client's logEvent writes. Every event
// from the strategist path is tagged strategist_v2:true so activation and
// posting rates can be compared between the two paths during rollout.
export async function recordEvent(userId, eventName, properties) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !userId) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/events`, {
      method: "POST", headers: headers(),
      body: JSON.stringify({ user_id: userId, event_name: eventName, properties: Object.assign({ strategist_v2: true }, properties || {}) }),
    });
  } catch (e) { console.warn("[events] insert threw", e.message); }
}

// Shared rate-limit RPC (service role only). Fails open like chat.js.
export async function checkRateLimit(userId, endpoint, perMinute, perHour) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_and_record_rate_limits`, {
      method: "POST", headers: headers(),
      body: JSON.stringify({ p_user_id: userId, p_endpoint: endpoint, p_minute_max: perMinute, p_hour_max: perHour }),
    });
    if (!res.ok) return { ok: true };
    const result = await res.json();
    return result === "ok" ? { ok: true } : { ok: false, kind: result };
  } catch (e) { return { ok: true }; }
}
