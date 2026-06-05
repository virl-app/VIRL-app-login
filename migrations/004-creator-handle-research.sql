-- ─────────────────────────────────────────────────────────────────────────────
-- [HANDLE-RESEARCH] Cache table for per-user social-profile research.
--
-- Stores the Perplexity-generated summary of what each user posts about on
-- their connected platforms (topics, voice, visual signatures) so future
-- plan/script/caption generations can lean on it instead of writing
-- generic "you" content. Cached because:
--   1. Perplexity calls cost real money (~$0.001 per research call)
--   2. A user's posting patterns don't change day-to-day
--   3. Latency: avoids adding ~3s of Perplexity round-trip to every generation
--
-- Refresh policy: TTL = 30 days, OR forced refresh when the user's handles
-- change (detected via handles_hash). The lazy refresh fires inside the
-- chat.js Promise.all on the first stale-cache plan generation per user.
--
-- Falls back gracefully: if Perplexity returns nothing useful or the row
-- is missing, the prompt builder just skips the research block — the rest
-- of the creator context still flows through normally.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.creator_handle_research (
  user_id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  research_text  text         NOT NULL,
  handles_hash   text         NOT NULL,
  fetched_at     timestamptz  NOT NULL DEFAULT now()
);

-- Lookup pattern is single-row by user_id; the PK index covers it. No
-- secondary index needed.
