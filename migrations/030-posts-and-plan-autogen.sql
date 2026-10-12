-- ─────────────────────────────────────────────────────────────────────────────
-- [PR2] posts, the proactive-plan opt-in, timezone and brand colours.
--
-- posts. One row per plan card per week, the first server-side record of
-- what a creator actually did with a post. "Posted" used to live only in
-- the browser (localStorage virl_posted_<title+day>) and "skipped" did
-- not exist. The monthly review (PR 3) reads this table and nothing else.
--   card_key          title + day, the id every other table uses for a card
--   pillar/pillar_role from the plan card (strategy accounts)
--   status            planned | posted | skipped
--   skip_reason       no_time | not_me | didnt_know_how  (the one optional chip)
--   self_result       flopped | okay | popped            (PR 3)
--   attributed_result e.g. "DM", "booking"               (PR 3)
--   edits_made        the creator edited the draft before posting
--   is_rework         a rework of the primary platform's idea, not a native plan
--   rendered          the week's rendered static post
--
-- The browser writes its own rows (RLS below); the autogen cron writes with
-- the service key. Existing localStorage posted marks are backfilled by the
-- client the first time it loads a plan after this ships.
--
-- profiles.plan_autogen  opt-in: have the plan ready the evening before the
--                        content slot (off by default, brief: proactive plans
--                        are opt-in).
-- profiles.timezone      IANA zone, captured from the browser on every plan
--                        request so slot timing lands in local time.
-- profiles.brand         { bg, fg, accent } hex colours for the rendered post;
--                        VIRL defaults when null.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.posts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  week_start        date NOT NULL,
  card_key          text NOT NULL,
  day               text,
  title             text,
  platform          text,
  format            text,
  pillar            text,
  pillar_role       text,
  status            text NOT NULL DEFAULT 'planned',
  posted_at         timestamptz,
  skip_reason       text,
  self_result       text,
  attributed_result text,
  edits_made        boolean NOT NULL DEFAULT false,
  is_rework         boolean NOT NULL DEFAULT false,
  rendered          boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start, card_key)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_status_values') THEN
    ALTER TABLE public.posts ADD CONSTRAINT posts_status_values
      CHECK (status IN ('planned', 'posted', 'skipped'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_skip_reason_values') THEN
    ALTER TABLE public.posts ADD CONSTRAINT posts_skip_reason_values
      CHECK (skip_reason IS NULL OR skip_reason IN ('no_time', 'not_me', 'didnt_know_how'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_pillar_role_values') THEN
    ALTER TABLE public.posts ADD CONSTRAINT posts_pillar_role_values
      CHECK (pillar_role IS NULL OR pillar_role IN ('reach', 'trust', 'connection', 'convert'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'posts_self_result_values') THEN
    ALTER TABLE public.posts ADD CONSTRAINT posts_self_result_values
      CHECK (self_result IS NULL OR self_result IN ('flopped', 'okay', 'popped'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS posts_user_week_idx ON public.posts (user_id, week_start DESC);

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS posts_select_own ON public.posts;
DROP POLICY IF EXISTS posts_insert_own ON public.posts;
DROP POLICY IF EXISTS posts_update_own ON public.posts;
CREATE POLICY posts_select_own ON public.posts FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY posts_insert_own ON public.posts FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY posts_update_own ON public.posts FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS plan_autogen boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS timezone     text,
  ADD COLUMN IF NOT EXISTS brand        jsonb;
