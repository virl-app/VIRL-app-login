-- ─────────────────────────────────────────────────────────────────────────────
-- [COMPLIANCE 2] Per-user country signal
--
-- Adds profiles.country so the per-niche compliance loader can gate the
-- guardrail block on the user's actual locale instead of treating
-- everyone as US. Existing rows default to 'US' — that preserves today's
-- behavior (the v1 chat.js hardcoded "US" when calling
-- getComplianceForNiche). New signups capture the value via the signup
-- flow in index.html; the profile settings tab edits it after the fact.
--
-- VIRL is anchored in the US today, so 'US' is a safer default than NULL
-- for the lookup path — the loader's locale-gating short-circuits on
-- unsupported locales, but a NULL country would also short-circuit and
-- silently disable compliance for everyone who hasn't filled out the
-- field. Defaulting to 'US' keeps the floor active until a user
-- explicitly says they're elsewhere.
--
-- Storage is a free-text ISO-3166 alpha-2 code ('US', 'CA', 'GB', etc.)
-- — no FK to a country table because the only reader (compliance.js)
-- only ever cares whether the value is in its SUPPORTED_LOCALES set.
--
-- Idempotent — safe to re-run. Run in Supabase SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT 'US';

-- No index — country isn't a query predicate today. The compliance loader
-- reads it as one column of the profile row already fetched per request.
-- Add an index later if we grow per-country admin queries.

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (run separately after the migration).
-- ─────────────────────────────────────────────────────────────────────────────

-- V1. Column exists with the right default.
-- SELECT column_name, data_type, column_default, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'profiles' AND column_name = 'country';
-- Expected: text, 'US'::text, NO

-- V2. All existing rows defaulted to 'US' (no NULL).
-- SELECT country, COUNT(*) FROM profiles GROUP BY country;

-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback (only if something goes catastrophically wrong).
-- ─────────────────────────────────────────────────────────────────────────────
-- BEGIN;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS country;
-- COMMIT;
