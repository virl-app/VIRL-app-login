-- ─────────────────────────────────────────────────────────────────────────────
-- [EMAIL-CUTOVER] email_preferences canonical schema + GDPR-safe default
-- flip + backfill from auth.users.raw_user_meta_data.marketing_opt_in.
--
-- Background: the email_preferences table was created via the Supabase
-- dashboard at some point before this migration and is referenced by
--   - api/_lib/email-send.js (isMarketingOptedOut suppression check)
--   - api/email/unsubscribe.js (one-click unsub writes opt_out=true)
--   - index.html signup handler (upsert on signup, inverted from
--     marketing_opt_in checkbox)
-- but had two §9-audit gaps:
--   1. Schema not in /migrations — drift risk
--   2. Missing-row default = "opted IN" (because email-send.js falls back
--      to `false` when no row exists). This is GDPR-questionable: a user
--      whose row writes failed at signup gets marketing emails by default.
--
-- This migration fixes both. CREATE TABLE IF NOT EXISTS makes it
-- idempotent against the existing dashboard-created table. The column
-- default flips from "false" (opt-IN) to "true" (opt-OUT). A backfill
-- inserts a row for every auth.users row that doesn't already have one,
-- reading the explicit consent state from raw_user_meta_data.marketing_opt_in
-- (the atomic write from supabaseClient.auth.signUp's options.data).
--
-- Run in Supabase SQL Editor against the production database. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_preferences (
  user_id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  marketing_opt_out  boolean      NOT NULL DEFAULT true,
  updated_at         timestamptz  NOT NULL DEFAULT now()
);

-- Flip the column default. If the table already existed with default=false
-- (the original "opted in by default" state) this brings it in line with
-- the GDPR-safe stance. Existing row values are not touched — the backfill
-- below handles those.
ALTER TABLE public.email_preferences
  ALTER COLUMN marketing_opt_out SET DEFAULT true;

-- Backfill rows for every signed-up user that doesn't already have an
-- email_preferences row. Source of truth for the initial opt-in is
-- raw_user_meta_data.marketing_opt_in (set atomically during signUp
-- via options.data). When marketing_opt_in is missing or false, the user
-- is opted OUT — matches the GDPR-safe default.
--
-- Note: ::boolean cast is required because user_metadata is JSONB and
-- ->> returns text. COALESCE handles the pre-flag-era users whose
-- raw_user_meta_data may be empty or missing the key entirely.
INSERT INTO public.email_preferences (user_id, marketing_opt_out, updated_at)
SELECT
  u.id,
  COALESCE((u.raw_user_meta_data->>'marketing_opt_in')::boolean, false) = false,
  COALESCE(u.created_at, now())
FROM auth.users u
LEFT JOIN public.email_preferences p ON p.user_id = u.id
WHERE p.user_id IS NULL;

-- Suppression-check read path (isMarketingOptedOut in email-send.js) does
-- a single-key lookup by user_id with marketing_opt_out projected. The
-- PRIMARY KEY constraint already provides the index, but an explicit
-- index on the same key keeps the EXPLAIN plan stable if the table ever
-- accumulates ancillary columns.
CREATE INDEX IF NOT EXISTS idx_email_preferences_user_id
  ON public.email_preferences(user_id);
