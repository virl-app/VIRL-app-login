-- ─────────────────────────────────────────────────────────────────────────────
-- [VOICE-DRIFT-GATE] Per-generation tracking columns for the voice-drift
-- gate, so the admin Dashboard can show how often the corrective retry fires,
-- whether it actually improves voice, and what it costs.
--
-- The gate already folds the retry's tokens into the existing usage_events
-- row (input/output/cache/est_cost), so a retry's spend is ALREADY in total
-- cost. These columns add what the totals can't tell you: WHICH rows were
-- retries, the before/after drift scores, and the retry's MARGINAL estimated
-- cost (so the panel can isolate "extra spend caused by the gate").
--
--   drift_retried        — true when the gate fired a corrective retry on
--                          this generation. NULL/false otherwise (plan,
--                          streaming, no voice reference, below threshold).
--   drift_score_before   — composite drift score (0-100) of the first draft.
--   drift_score_after    — composite drift score of the retry's draft. The
--                          retry was KEPT iff after < before.
--   drift_retry_cost_usd — estimated USD cost of the extra retry call alone
--                          (already counted inside est_cost_usd; surfaced
--                          separately for attribution).
--
-- All nullable, no default beyond NULL: existing rows + every non-retry row
-- read back as "no drift retry" cleanly. IMPORTANT: this migration must be
-- applied BEFORE the chat.js change deploys — PostgREST rejects an INSERT
-- referencing columns that don't exist yet, which would fail the whole
-- usage_events write.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.usage_events
  ADD COLUMN IF NOT EXISTS drift_retried        boolean,
  ADD COLUMN IF NOT EXISTS drift_score_before   real,
  ADD COLUMN IF NOT EXISTS drift_score_after    real,
  ADD COLUMN IF NOT EXISTS drift_retry_cost_usd numeric(10,6);

-- [PostgREST] Reload the schema cache so the new columns are immediately
-- writable/selectable via the REST API (same fix used by migrations 015/016).
NOTIFY pgrst, 'reload schema';
