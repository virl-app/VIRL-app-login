-- ─────────────────────────────────────────────────────────────────────────────
-- [WEEK-START] Give the creator's planning week its own start day, decoupled
-- from the billing/credit cycle.
--
-- Background: VIRL had four disagreeing definitions of "this week":
--   1. The plan's own day labels  — Day 1 = the day you pressed Generate
--      (api/_lib/prompts.js, buildPlan)
--   2. plan_history filing        — always calendar Monday
--      (weekStartISO in index.html, weekStartUTC in api/_lib/plan-history.js)
--   3. "Your plan expires..."     — credits.reset_at
--      (computePlanExpiry in index.html)
--   4. Credit refill              — rolling 7 days from the last lazy reset
--      (api/chat.js), re-anchored again on upgrade (api/stripe-webhook.js)
--
-- None of them was the creator's own planning rhythm, and (4) drifts later
-- every cycle because the lazy reset sets reset_at = now() + 7 days on the
-- first generation AFTER expiry. Miss two days, and your week moves two days
-- later — permanently.
--
-- This column becomes the single answer to "when does my week start" for
-- everything on the planning side (1, 2 and 3). The credit cycle (4) keeps
-- its own rolling cadence and is deliberately NOT driven by this value:
-- if the user could move the refill date, they could farm partial refills
-- by flipping the setting.
--
-- 0 = Sunday .. 6 = Saturday, matching JS Date#getDay() so the client, the
-- server prompt builder, and this column all speak the same dialect. Default
-- 0 (Sunday) — the common planning convention, and what prompted the change.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS week_start_day smallint NOT NULL DEFAULT 0;

-- Guard the range at the schema level. The client sends this from a picker,
-- but week math silently produces garbage windows for out-of-range values
-- rather than throwing, so catch it here.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_week_start_day_range'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_week_start_day_range
      CHECK (week_start_day BETWEEN 0 AND 6);
  END IF;
END $$;

-- ── Backfill plan_history keys ───────────────────────────────────────────────
-- Every existing plan_history row is keyed to a calendar Monday. The prompt's
-- week number is computed as floor(days_between(first_week, this_week) / 7) + 1
-- (calendarWeekNumber in api/_lib/plan-history.js). Leaving Monday-keyed
-- history in place while new rows land on Sunday makes that gap 6 days short
-- of a clean multiple, so a user who was told "week 5" last time gets told
-- "week 4" this time — VIRL appearing to lose track of their history.
--
-- Re-anchor each row to the most recent occurrence of that user's
-- week_start_day on or before its current key. Written generically (not as a
-- flat "-1 day") so it stays correct if the default above ever changes.
--
-- Uniqueness: rows are NOT guaranteed to shift by a uniform per-user offset.
-- Production already holds a couple of Sunday-keyed rows alongside the Monday
-- ones — an artifact of the old client helper calling toISOString() on a
-- LOCAL midnight, which rolls back a day for anyone ahead of UTC. So a user
-- can hold two rows whose keys collapse onto the same date once shifted,
-- which would trip the (user_id, week_start) unique key and abort the whole
-- migration.
--
-- Verified collision-free against production at the time of writing, but the
-- NOT EXISTS guard makes that a property of the migration rather than of a
-- snapshot: a row whose target key is already taken is left where it is. It
-- keeps a stale anchor, which calendarWeekNumber's rounding absorbs, instead
-- of taking the rest of the backfill down with it.
UPDATE public.plan_history ph
   SET week_start = ph.week_start
                  - (( EXTRACT(DOW FROM ph.week_start)::int
                       - COALESCE(p.week_start_day, 0) + 7 ) % 7)
   FROM public.profiles p
  WHERE p.id = ph.user_id
    AND (( EXTRACT(DOW FROM ph.week_start)::int
           - COALESCE(p.week_start_day, 0) + 7 ) % 7) <> 0
    AND NOT EXISTS (
      SELECT 1 FROM public.plan_history other
       WHERE other.user_id = ph.user_id
         AND other.week_start = ph.week_start
                              - (( EXTRACT(DOW FROM ph.week_start)::int
                                   - COALESCE(p.week_start_day, 0) + 7 ) % 7)
    );
