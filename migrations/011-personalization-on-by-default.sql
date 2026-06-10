-- ─────────────────────────────────────────────────────────────────────────────
-- [LEARNING-CONSENT] Flip the default for the four learning-consent toggles
-- to TRUE so new accounts ship opted-in to personalization. Existing rows
-- are left alone — users who deliberately turned a toggle OFF keep their
-- choice; users who never explicitly set a value keep whatever they
-- currently have (typically FALSE from the original migration).
--
-- The product surface backing this:
--   - A new master "Personalization on" toggle in Profile → Personalization
--     & Privacy that visualises the overall state and bulk-toggles all four.
--   - Disclosure copy on the profile screen explaining what's captured.
--   - Privacy policy disclosure (Termly) covering the data + the controls.
--
-- ALTER COLUMN ... SET DEFAULT only affects future INSERTs — existing rows
-- and their values are untouched, which is the behavior we want.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ALTER COLUMN learn_from_edits        SET DEFAULT true;

ALTER TABLE public.profiles
  ALTER COLUMN learn_from_vault        SET DEFAULT true;

ALTER TABLE public.profiles
  ALTER COLUMN learn_from_results      SET DEFAULT true;

ALTER TABLE public.profiles
  ALTER COLUMN learn_from_public_posts SET DEFAULT true;
