-- ─────────────────────────────────────────────────────────────────────────────
-- [PRICING 2] Founder Circle schema migration
--
-- Adds the schema required for the Founder Circle pricing tier:
--   - founding_tier identity column on credits (permanent, set once)
--   - founding_position pointer (1..50 for Founder Circle members)
--   - resubscription tracking (last_resubscribed_at, resubscription_count)
--   - subscription_started_at for first-signup audit
--   - founding_positions table with 50 pre-allocated empty slots
--   - profiles.city for the "where are you based" capture on signup
--
-- "Filled" is determined by founding_positions.filled_at IS NOT NULL, not
-- user_id IS NOT NULL. This preserves the no-take-backs rule even if a user
-- later deletes their account (FK nulls out but the slot stays marked filled).
--
-- Grandfathers existing plan='founding' rows into Founder Circle positions
-- ordered by auth.users.created_at. Idempotent — safe to re-run.
--
-- Run in Supabase SQL Editor against the production database.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 2a. Extend credits with founder identity columns.
ALTER TABLE credits
  ADD COLUMN IF NOT EXISTS founding_tier TEXT NOT NULL DEFAULT 'standard'
    CHECK (founding_tier IN ('founder_circle', 'standard')),
  ADD COLUMN IF NOT EXISTS founding_position INTEGER,
  ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_resubscribed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resubscription_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_credits_founding_tier
  ON credits(founding_tier);
CREATE INDEX IF NOT EXISTS idx_credits_founding_position
  ON credits(founding_position);

-- 2b. founding_positions — 50 fixed slots, pre-populated empty.
CREATE TABLE IF NOT EXISTS founding_positions (
  position   INTEGER PRIMARY KEY CHECK (position BETWEEN 1 AND 50),
  user_id    UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  filled_at  TIMESTAMPTZ
);

INSERT INTO founding_positions (position)
SELECT generate_series(1, 50)
ON CONFLICT (position) DO NOTHING;

-- 2c. profiles.city for the "where are you based" question on signup.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS city TEXT;

-- 2d. Grandfather any existing plan='founding' users into Founder Circle.
-- Order by auth.users.created_at so positions reflect signup order and are
-- deterministic across reruns. CTE renames columns to avoid the markdown
-- autolink trap on <alias>.id patterns when this file is copy-pasted.
WITH auth_users_snapshot AS (
  SELECT id AS user_id_col, created_at AS created_at_col
  FROM auth.users
),
ordered_founders AS (
  SELECT
    c.user_id,
    ROW_NUMBER() OVER (
      ORDER BY au.created_at_col ASC, c.user_id ASC
    ) AS rn,
    au.created_at_col AS user_created_at
  FROM credits c
  JOIN auth_users_snapshot au ON au.user_id_col = c.user_id
  WHERE c.plan = 'founding'
    AND c.founding_position IS NULL
),
positions_to_assign AS (
  SELECT user_id, rn AS position, user_created_at
  FROM ordered_founders
  WHERE rn <= 50
)
UPDATE founding_positions fp
SET
  user_id   = pta.user_id,
  filled_at = COALESCE(fp.filled_at, pta.user_created_at, NOW())
FROM positions_to_assign pta
WHERE fp.position = pta.position
  AND fp.user_id IS NULL;

UPDATE credits c
SET
  founding_tier           = 'founder_circle',
  founding_position       = fp.position,
  subscription_started_at = COALESCE(c.subscription_started_at, fp.filled_at)
FROM founding_positions fp
WHERE fp.user_id = c.user_id
  AND c.founding_tier <> 'founder_circle';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries (run separately after the migration).
-- ─────────────────────────────────────────────────────────────────────────────

-- V1. Confirm 50 position rows exist.
-- SELECT COUNT(*) AS total_positions FROM founding_positions;
-- Expected: 50

-- V2. Filled positions (grandfathered).
-- SELECT COUNT(*) AS filled_positions
-- FROM founding_positions WHERE filled_at IS NOT NULL;
-- Expected: equals count of pre-existing plan='founding' rows

-- V3. founding_tier distribution.
-- SELECT founding_tier, COUNT(*) FROM credits GROUP BY founding_tier;

-- V4. No founder positions outside 1..50.
-- SELECT MIN(founding_position), MAX(founding_position)
-- FROM credits WHERE founding_position IS NOT NULL;

-- V5. No duplicate user_id in founding_positions.
-- SELECT user_id, COUNT(*) FROM founding_positions
-- WHERE user_id IS NOT NULL GROUP BY user_id HAVING COUNT(*) > 1;

-- V6. credits.founding_position matches founding_positions.position.
-- SELECT fp.position, fp.user_id, c.founding_position, c.founding_tier
-- FROM founding_positions fp
-- LEFT JOIN credits c ON c.user_id = fp.user_id
-- WHERE fp.user_id IS NOT NULL
--   AND (c.founding_position IS DISTINCT FROM fp.position
--        OR c.founding_tier <> 'founder_circle');
-- Expected: 0 rows

-- V7. Confirm profiles.city exists.
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'profiles' AND column_name = 'city';

-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback (only if something goes catastrophically wrong).
-- ─────────────────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP TABLE IF EXISTS founding_positions;
-- ALTER TABLE credits
--   DROP COLUMN IF EXISTS founding_tier,
--   DROP COLUMN IF EXISTS founding_position,
--   DROP COLUMN IF EXISTS subscription_started_at,
--   DROP COLUMN IF EXISTS last_resubscribed_at,
--   DROP COLUMN IF EXISTS resubscription_count;
-- ALTER TABLE profiles
--   DROP COLUMN IF EXISTS city;
-- DROP INDEX IF EXISTS idx_credits_founding_tier;
-- DROP INDEX IF EXISTS idx_credits_founding_position;
-- COMMIT;
