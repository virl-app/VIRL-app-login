-- [PR3] Tell me what worked: the monthly review, attribution, the insights
-- bridge and the voice check.
--
-- posts.attributed_result   one tap on a posted post: dm | booking | new_client |
--                           brand_inquiry | other   (column exists since 030)
-- posts.self_result         flopped | okay | popped (column exists since 030)
-- posts.insights            jsonb from a screenshot of the platform's insights:
--                           { reach, views, likes, comments, shares, saves,
--                             profile_visits, dms, platform, confidence }
-- posts.insights_source     'screenshot' for now; integrations later.
--
-- strategy_reviews          one row per review the strategist writes. The
--                           review JSON holds the opening paragraph, the
--                           findings with their evidence, and 1 to 3 proposals,
--                           each an RFC 6902 patch against the strategy with
--                           a decision (null | accepted | kept). Written by the
--                           server; the user reads and decides.
-- voice_checks              one row per "Which sounds more like you?" pick:
--                           which variant carried the voice fingerprint and
--                           whether the creator picked it.
-- profiles.last_voice_check when the last check was shown (one every 14 days).
-- profiles.voice_sample_asked_at when the strategist last asked for a fresh
--                           sample (after two reviews under 60%).
--
-- Run in Supabase SQL Editor. Idempotent.

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS insights        jsonb,
  ADD COLUMN IF NOT EXISTS insights_source text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_attributed_result_values') THEN
    ALTER TABLE public.posts ADD CONSTRAINT posts_attributed_result_values
      CHECK (attributed_result IS NULL OR attributed_result IN ('dm', 'booking', 'new_client', 'brand_inquiry', 'other'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.strategy_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  review        jsonb NOT NULL,
  stats         jsonb,
  voice_rate    real,
  status        text NOT NULL DEFAULT 'open',
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'strategy_reviews_status_values') THEN
    ALTER TABLE public.strategy_reviews ADD CONSTRAINT strategy_reviews_status_values
      CHECK (status IN ('open', 'done'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS strategy_reviews_user_idx ON public.strategy_reviews (user_id, created_at DESC);
ALTER TABLE public.strategy_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS strategy_reviews_select_own ON public.strategy_reviews;
CREATE POLICY strategy_reviews_select_own ON public.strategy_reviews FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.voice_checks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  week_start         date,
  card_key           text,
  picked_fingerprint boolean NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_checks_user_idx ON public.voice_checks (user_id, created_at DESC);
ALTER TABLE public.voice_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_checks_select_own ON public.voice_checks;
DROP POLICY IF EXISTS voice_checks_insert_own ON public.voice_checks;
CREATE POLICY voice_checks_select_own ON public.voice_checks FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY voice_checks_insert_own ON public.voice_checks FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_voice_check       timestamptz,
  ADD COLUMN IF NOT EXISTS voice_sample_asked_at  timestamptz;
