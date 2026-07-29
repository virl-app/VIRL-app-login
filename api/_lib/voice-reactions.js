// [REACTION-LOOP] Server-side reader for the one-tap reaction chips.
// Pulls a creator's recent thumbs-down reasons and shapes them into the
// aggregate the prompt builder turns into standing voice corrections.
//
// Sibling of _lib/edit-examples.js, and deliberately built the same way:
// edit diffs were the only feedback loop in the app that actually closed,
// so the chips now travel the same road (read newest-first → cap → format
// into the system prompt → fail open to silence).
//
// Where it differs from edits, and why:
//
//   Edit diffs are EVIDENCE — a before/after pair the model can imitate
//   directly. Reactions are a VERDICT: the creator says a draft was too
//   formal, but not what "right" would have been. So a single reaction is
//   weak signal and a repeated one is strong signal, which is why this
//   returns counts rather than a flat list. Three "too formal" taps in a
//   fortnight is a voice instruction; one is a bad afternoon.
//
//   Reactions also have to EXPIRE. An edit diff stays true forever — the
//   creator really did rewrite that line that way. A complaint is about a
//   draft VIRL has since had the chance to fix, so a reaction from four
//   months ago is at best stale and at worst a correction VIRL keeps
//   over-applying long after it has landed. Hence the recency window.
//
// Consent: none required, unlike edits (passive capture of private
// revisions) or public-post research (third-party data). Tapping a button
// labelled "Too formal" IS the opt-in — it is the creator deliberately
// telling VIRL something about its output, and the only thing done with
// it is shaping that same creator's own next drafts. Making the tap mean
// nothing is the bug being fixed here; putting it behind a second,
// separate toggle would recreate the same silence with extra steps.
//
// Fail-open: any error returns an empty array and the prompt simply skips
// the block — generation never blocks on missing learning signal.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const SUPABASE_HEADERS = {
  apikey:        SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
};

// How far back a reaction still counts. Long enough that a creator who
// rates once a week accumulates a real pattern; short enough that a
// complaint VIRL has since corrected stops steering.
const RECENCY_DAYS = 60;
// Rows to pull. Reactions are rare per user (they require a thumbs-down
// AND a chip tap), so this ceiling is generous.
const MAX_ROWS = 30;
// Distinct reasons that can reach the prompt. There are only three chips
// today; the cap is here so that widening the chip vocabulary later
// can't quietly widen the prompt block along with it.
const MAX_REASONS = 4;

// Returns [{ reason, count, lastAt, lastType }, ...] ordered by count
// desc (strongest signal first), or [] when there's nothing usable.
export async function fetchVoiceReactions(userId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return [];
  if (!userId) return [];

  const since = new Date(Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let rows;
  try {
    const url = `${SUPABASE_URL}/rest/v1/content_ratings`
      + `?user_id=eq.${userId}`
      + `&rating=eq.down`
      + `&reason=not.is.null`
      + `&reason_at=gte.${encodeURIComponent(since)}`
      + `&select=reason,reason_at,generation_type`
      + `&order=reason_at.desc`
      + `&limit=${MAX_ROWS}`;
    const res = await fetch(url, { headers: SUPABASE_HEADERS });
    // A 400 here is the expected shape on a deploy that landed ahead of
    // migration 025 (unknown column `reason`). Same fail-open as any
    // other error — no research block, no broken generation.
    if (!res.ok) return [];
    rows = await res.json();
  } catch (e) { return []; }
  if (!Array.isArray(rows) || !rows.length) return [];

  const byReason = new Map();
  for (const row of rows) {
    const reason = row && typeof row.reason === "string" ? row.reason.trim() : "";
    if (!reason) continue;
    const existing = byReason.get(reason);
    if (existing) {
      existing.count++;
      continue;
    }
    // Rows arrive newest-first, so the first sighting of a reason is
    // also its most recent — no date comparison needed.
    byReason.set(reason, {
      reason,
      count:    1,
      lastAt:   row.reason_at || null,
      lastType: row.generation_type || null,
    });
  }

  return Array.from(byReason.values())
    .sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return String(b.lastAt || "").localeCompare(String(a.lastAt || ""));
    })
    .slice(0, MAX_REASONS);
}
