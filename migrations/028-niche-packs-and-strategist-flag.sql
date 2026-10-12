-- ─────────────────────────────────────────────────────────────────────────────
-- [PR0] Niche packs + the strategist_v2 rollout flag.
--
-- Niche packs. The 17-value niche picker collapses to three packs:
--   'Real Estate' | 'Small Business' | 'Creators & Personal Brands'
-- The old value is kept, because two things still key off it and work
-- better with the finer label: the Real Estate / Wellness phrase floor in
-- api/_lib/compliance.js and the trend-research segments in
-- api/_lib/trend-context.js. Server code resolves `legacy_niche || pack`
-- in one place (api/chat.js) so nothing downstream changes behaviour.
--
-- There is nothing to backfill here. The niche was never stored on the
-- server: it lived in each browser's localStorage and rode every request as
-- params.niche. So the migration happens client-side on the user's next
-- login (index.html, [NICHE-PACKS]): the old stored value is written to
-- legacy_niche once, and the pack is derived from it:
--   Real Estate                       -> Real Estate
--   Small Business, Healthcare & Medical -> Small Business
--   anything else                     -> Small Business when the profile
--                                        lists offerings / a service area /
--                                        a call to action, otherwise
--                                        Creators & Personal Brands
--
-- strategist_v2. One flag per account for the strategist rollout (PR 1+).
-- A separate table rather than a profiles column: the browser writes
-- profiles directly with the anon key, so a column there would let any
-- user switch their own flag on. account_flags is readable by its owner
-- and writable only with the service key. Off for everyone; Lauren's
-- account gets a row so her test accounts see the new path first.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS niche_pack text;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS legacy_niche text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_niche_pack_values'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_niche_pack_values
      CHECK (niche_pack IS NULL OR niche_pack IN ('Real Estate', 'Small Business', 'Creators & Personal Brands'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.account_flags (
  user_id       uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  strategist_v2 boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.account_flags ENABLE ROW LEVEL SECURITY;

-- Owner can read their own flags. No INSERT/UPDATE policy on purpose: writes
-- go through the service key (admin tooling), never the browser.
DROP POLICY IF EXISTS account_flags_select_own ON public.account_flags;
CREATE POLICY account_flags_select_own ON public.account_flags
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Lauren first. Harmless if the account is missing or the row exists.
INSERT INTO public.account_flags (user_id, strategist_v2)
SELECT id, true FROM auth.users WHERE email = 'laurenannedoty@gmail.com'
ON CONFLICT (user_id) DO NOTHING;
