-- ─────────────────────────────────────────────────────────────────────────────
-- [VOICE-REFERENCE] Add voice_samples to profiles — an optional array of
-- additional caption examples beyond the single `sample_caption` field, so
-- users with a thin reference corpus can paste more material for the voice-
-- drift telemetry (and future few-shot exemplars) to compare against.
--
-- Why a new column instead of widening sample_caption:
--   - sample_caption remains a single required-ish field threaded into the
--     prompt as "match this tone exactly." Backward compatible: existing
--     consumers see no change.
--   - voice_samples is unbounded-by-shape (text[]) but capped in the UI at
--     4 additional entries (5 total counting the primary caption). Cap is
--     UX, not schema, so we can revisit without a migration.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS voice_samples text[] NOT NULL DEFAULT '{}';
