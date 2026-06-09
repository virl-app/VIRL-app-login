-- ─────────────────────────────────────────────────────────────────────────────
-- [LEARNING-CONSENT] Three new opt-in toggles for personalization features
-- that use creator content as AI learning input. All default FALSE — explicit
-- contextual consent at the first relevant action, plus a persistent toggle
-- in Profile → Personalization & Privacy.
--
-- The existing learn_from_edits column (migration done previously, lives in
-- profiles already) covers edit diffs. This migration adds the other three:
--
--   learn_from_vault         — use saved vault items as few-shot voice
--                              exemplars in plan / caption / script prompts
--                              (the vault-exemplars feature gates on this).
--   learn_from_results       — use logged engagement to rank exemplars and
--                              stamp the "performed well" tag.
--   learn_from_public_posts  — call Perplexity to research the user's
--                              public posts on the handles they provided
--                              (the handle-research feature gates on this).
--
-- All forward-looking: turning a toggle off stops future use, but doesn't
-- delete the data already collected. To wipe past learning data the user
-- has to delete their account (Settings → Delete account).
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS learn_from_vault boolean NOT NULL DEFAULT false;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS learn_from_results boolean NOT NULL DEFAULT false;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS learn_from_public_posts boolean NOT NULL DEFAULT false;
