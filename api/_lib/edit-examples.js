// Server-side helper for the learn-from-edits feature. Pulls a user's
// recent plan-card edit diffs from the events table and formats them
// as a voice-example block for the plan generator.
//
// The diffs are stored as { field, before, after } objects inside the
// plan_card_edited event's `properties.changes` array — captured by
// updateCardAt on the client whenever profile.learnFromEdits is ON.
// Events without a `changes` array are events from before the user
// opted in (or events from cards edited while the toggle was off) and
// are skipped cleanly.
//
// Fail-open: any error during fetch / parse returns an empty array and
// the plan prompt simply skips the editsCtx block — generation never
// blocks on missing learning signal.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const SUPABASE_HEADERS = {
  apikey:        SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
};

// Cap on how many individual { field, before, after } diffs are
// returned. Each diff burns ~50-200 tokens once it lands in the
// prompt, so 8 is a reasonable upper bound — enough signal for the
// model to pick up a voice pattern, not enough to dominate the prompt
// or push the system block past its cache boundary.
const MAX_DIFFS = 8;

// Fetch up to N most-recent plan_card_edited events for a user that
// include the `changes` array (i.e., events fired while the user was
// opted in). Events ordered newest-first so the freshest revisions
// weigh hardest in the prompt.
//
// Limit is on EVENTS, not on diffs — a single event can carry multiple
// per-field diffs from one Save. We over-fetch to make sure we land
// MAX_DIFFS diffs even when early events touched a single field each.
async function fetchRecentEdits(userId, limit) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return [];
  if (!userId) return [];
  const eventLimit = limit || 12;
  try {
    const url = `${SUPABASE_URL}/rest/v1/events`
      + `?user_id=eq.${userId}`
      + `&event_name=eq.plan_card_edited`
      + `&select=properties,created_at`
      + `&order=created_at.desc`
      + `&limit=${eventLimit}`;
    const res = await fetch(url, { headers: SUPABASE_HEADERS });
    if (!res.ok) return [];
    const rows = await res.json();
    // Flatten { properties: { changes: [...] } } rows into a single
    // [{field, before, after}, ...] list. Skip rows without a changes
    // array (those are from before opt-in or pre-feature events). Cap
    // total diffs at MAX_DIFFS — newest-first ordering means we keep
    // the freshest signal and drop older revisions.
    const out = [];
    for (const row of rows) {
      const changes = row && row.properties && Array.isArray(row.properties.changes)
        ? row.properties.changes : null;
      if (!changes) continue;
      for (const c of changes) {
        if (!c || typeof c !== "object") continue;
        if (!c.field) continue;
        // Skip no-op diffs (defensive — client-side trim should catch
        // these, but the events table may contain older rows from
        // before that trim was added).
        const before = (c.before || "").toString();
        const after  = (c.after  || "").toString();
        if (!after || before === after) continue;
        out.push({ field: c.field, before: before, after: after });
        if (out.length >= MAX_DIFFS) return out;
      }
    }
    return out;
  } catch (e) { return []; }
}

export { fetchRecentEdits };
