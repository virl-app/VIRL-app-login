-- ─────────────────────────────────────────────────────────────────────────────
-- [PR1] The strategist's own columns on profiles.
--
--   onboarding_answers  raw answers from the interview, keyed by screen. Each
--                       field carries { value, source } where source is
--                       'stated' (the user typed it) or 'migrated' (mapped
--                       from the old 35-field profile on "Meet your
--                       strategist"), so the monthly review can tell them
--                       apart.
--   strategy            the current strategy JSON the build call returns and
--                       every later call reads. One object; shape documented
--                       in api/_lib/strategy-schema.js.
--   strategy_version    integer, bumps on every applied change.
--   strategy_history    prior versions: [{ version, label, at, strategy }].
--   strategist_notes    things the user told the strategist, verbatim, in
--                       the order they said them ("This isn't quite right").
--   content_slot        { weekday, time, place } from onboarding. PR 2's plan
--                       and reminder timing read it.
--   voice_sample        pasted captions or the transcribed voice note; the
--                       first post's raw material and the voice reference.
--   emoji_use / emoji_where
--                       the two "Sound like you" toggles. emoji_pref (the old
--                       Never / Sometimes / Always) stays and is kept in step
--                       by the client so existing prompts keep reading it.
--
-- Nothing here is NOT NULL: an account without a strategy keeps using the
-- old profile path until it has one (the flag decides which UI it sees).
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS onboarding_answers jsonb,
  ADD COLUMN IF NOT EXISTS strategy           jsonb,
  ADD COLUMN IF NOT EXISTS strategy_version   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS strategy_history   jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS strategist_notes   text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS content_slot       jsonb,
  ADD COLUMN IF NOT EXISTS voice_sample       text,
  ADD COLUMN IF NOT EXISTS emoji_use          text,
  ADD COLUMN IF NOT EXISTS emoji_where        text,
  ADD COLUMN IF NOT EXISTS strategy_built_at  timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_emoji_use_values') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_emoji_use_values
      CHECK (emoji_use IS NULL OR emoji_use IN ('none', 'few', 'lots'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_emoji_where_values') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_emoji_where_values
      CHECK (emoji_where IS NULL OR emoji_where IN ('end', 'anywhere'));
  END IF;
END $$;

-- The strategy columns are written by the server (service key) from
-- api/strategy.js. The browser's own update policy on profiles already lets a
-- user write their row; the server validates the JSON shape before it stores,
-- and a client-side write of `strategy` would only hurt that user's own plan.
