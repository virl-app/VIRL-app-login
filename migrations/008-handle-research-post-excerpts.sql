-- ─────────────────────────────────────────────────────────────────────────────
-- [VOICE-REFERENCE] Add post_excerpts column to creator_handle_research so
-- the cached Perplexity payload carries verbatim caption excerpts from the
-- user's actual posts alongside the descriptive paragraph.
--
-- Why a column instead of stuffing JSON into research_text:
--   - research_text remains a plain string the prompt builder injects as-is.
--     Mixing JSON into it would couple the cache shape to the prompt format.
--   - voice-drift.js consumes excerpts as a separate corpus (array of short
--     captions) — distinct shape, distinct lifecycle, distinct consumer.
--   - PostgREST returns text[] directly; no client-side parsing needed.
--
-- Backfill behavior: existing rows get an empty array. The 30-day TTL plus
-- handles_hash refresh means they'll re-populate naturally as users hit
-- /api/profile-research-prewarm or the lazy chat.js refresh. No forced
-- re-fetch required.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.creator_handle_research
  ADD COLUMN IF NOT EXISTS post_excerpts text[] NOT NULL DEFAULT '{}';
