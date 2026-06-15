-- ─────────────────────────────────────────────────────────────────────────────
-- [REST-DAY-LLM] Add a JSONB column to `plans` for storing the LLM-generated
-- rest-day tips that ride along with each plan generation. Tips are
-- personalized to the creator's niche, goal, and last-week wins, so they
-- need to persist with the plan they were generated for (otherwise a page
-- refresh or cross-device sign-in falls back to the static catalog).
--
-- Shape (JSONB array):
--   [
--     { "day": "Day 2 - Tuesday", "type": "engage",   "title": "...", "body": "..." },
--     { "day": "Day 5 - Friday",  "type": "research", "title": "...", "body": "..." }
--   ]
--
-- The client falls back to the static client-side catalog (REST_DAY_TIPS
-- in index.html) for any day that doesn't have an LLM tip — e.g., after
-- a user moves a card via drag-and-drop and creates a NEW empty day that
-- the LLM didn't anticipate. Belt-and-braces approach.
--
-- plan_history intentionally NOT touched in this migration. Last-week's-
-- plan UI doesn't currently render rest-day tips; adding the column there
-- can be a follow-up if/when historical tips need to surface.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS rest_day_tips jsonb;
