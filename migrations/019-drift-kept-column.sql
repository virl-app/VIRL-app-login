-- ─────────────────────────────────────────────────────────────────────────────
-- [VOICE-DRIFT-GATE] Persist whether the corrective retry's draft was
-- actually kept, so the admin dashboard's "kept rate" and improvement
-- averages reflect what the user received — not what was attempted.
--
-- Why: the drift gate records drift_score_after for EVERY retry attempt,
-- including ones that were discarded (because they truncated or scored
-- worse). The rollup in api/admin/usage-stats.js was re-deriving "kept" as
-- (after < before), missing the not-truncated condition the gate uses to
-- actually keep a draft. With this column, both the gate and the rollup
-- read the same truth instead of guessing.
--
--   drift_kept — true when the corrective retry's draft was kept (after <
--                before AND not truncated). NULL on rows where the gate
--                didn't fire (drift_retried IS NULL/false).
--
-- Nullable, no default beyond NULL: existing rows and every non-retry row
-- read back as "not applicable" cleanly. Like 018, this must be applied
-- BEFORE the chat.js change deploys — PostgREST rejects an INSERT
-- referencing columns that don't exist.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.usage_events
  ADD COLUMN IF NOT EXISTS drift_kept boolean;

-- [PostgREST] Reload schema cache so the new column is immediately usable.
NOTIFY pgrst, 'reload schema';
