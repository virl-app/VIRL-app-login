-- ─────────────────────────────────────────────────────────────────────────────
-- [COMP] Tester comp columns
--
-- Adds a per-user weekly-allowance override so a content creator testing VIRL
-- can be granted 150 tokens/week for a fixed window, then automatically revert
-- to normal — WITHOUT touching their plan, founding_tier, or Stripe linkage.
--
--   - comp_weekly_credits : the weekly allowance to grant while the comp is
--                           live (e.g. 150). NULL = no comp (the default).
--   - comp_expires_at     : when the comp ends. After this instant the lazy
--                           weekly reset in api/chat.js falls back to the
--                           normal plan-derived allowance (isPaid ? 150 : 20),
--                           and the 14-day trial gate applies again. NULL/past
--                           = inactive.
--
-- WHY this shape (vs. a cron / additive top-up): the only thing that refills
-- tokens is the lazy per-user reset in api/chat.js, which SETS credits to a
-- plan-derived amount when reset_at passes. A cron that ADDED tokens would be
-- overwritten by that reset on the same weekly boundary. Teaching the existing
-- reset to honor comp_weekly_credits is the set-and-forget path that expires on
-- its own. Nothing in the Stripe webhook reads these columns or the credits
-- balance, so this cannot collide with billing.
--
-- Idempotent — safe to re-run. Run in the Supabase SQL Editor against prod.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE credits
  ADD COLUMN IF NOT EXISTS comp_weekly_credits INTEGER,
  ADD COLUMN IF NOT EXISTS comp_expires_at     TIMESTAMPTZ;

-- Partial index: comp rows are a tiny minority, so only index the active ones.
CREATE INDEX IF NOT EXISTS idx_credits_comp_expires_at
  ON credits(comp_expires_at)
  WHERE comp_expires_at IS NOT NULL;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED THE TESTER COMP (run separately, after the migration above).
--
-- Fill in the tester's email. This grants 150/week for 84 days (= 12 weekly
-- windows / 3 months) starting now, and seeds the first week immediately so the
-- balance is live right away. The lazy reset in api/chat.js takes over from the
-- next weekly boundary and reverts automatically once comp_expires_at passes.
-- ─────────────────────────────────────────────────────────────────────────────
-- UPDATE credits
-- SET comp_weekly_credits = 150,
--     comp_expires_at     = now() + interval '84 days',
--     credits             = 150,
--     reset_at            = now() + interval '7 days'
-- WHERE user_id = (SELECT id FROM auth.users WHERE email = 'TESTER_EMAIL_HERE');

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries (run separately).
-- ─────────────────────────────────────────────────────────────────────────────

-- V1. Confirm the columns exist.
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'credits'
--   AND column_name IN ('comp_weekly_credits', 'comp_expires_at');

-- V2. Inspect the tester's comp + balance (plan/founding_tier untouched).
-- SELECT user_id, plan, founding_tier, credits, reset_at,
--        comp_weekly_credits, comp_expires_at
-- FROM credits
-- WHERE user_id = (SELECT id FROM auth.users WHERE email = 'TESTER_EMAIL_HERE');

-- V3. End the comp early if needed (reverts on next reset).
-- UPDATE credits
-- SET comp_weekly_credits = NULL, comp_expires_at = NULL
-- WHERE user_id = (SELECT id FROM auth.users WHERE email = 'TESTER_EMAIL_HERE');

-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback (only if removing the feature entirely).
-- ─────────────────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP INDEX IF EXISTS idx_credits_comp_expires_at;
-- ALTER TABLE credits
--   DROP COLUMN IF EXISTS comp_weekly_credits,
--   DROP COLUMN IF EXISTS comp_expires_at;
-- COMMIT;
