-- ─────────────────────────────────────────────────────────────────────────────
-- [WEEKLY-RESET-ANCHOR] Anchor a new user's FIRST credit-reset window to
-- their signup moment instead of the next calendar Monday.
--
-- Background: credits reset on a per-user 7-day window stored in
-- credits.reset_at. The lazy reset in api/chat.js already re-anchors that
-- window to now() + 7 days on the first generation after expiry — so for
-- active users the reset day tracks their own signup/usage rhythm. But the
-- FIRST window was seeded here as:
--
--     date_trunc('week', now() + interval '7 days')
--
-- which snaps to Monday 00:00 UTC. That made a brand-new user's very first
-- reset — and the weekly_reset reminder that is now anchored to reset_at
-- (see api/cron/email-triggers.js) — land on a Monday instead of their own
-- signup day. A Tuesday signup should get their first reset (and reminder)
-- ~the following Tuesday, not the Monday before it.
--
-- Fix: seed the first window as now() + interval '7 days', matching the
-- lazy-reset cadence in api/chat.js exactly. Everything else in the trigger
-- (attorney Pro provisioning, profiles insert, on-conflict no-ops) is
-- unchanged. CREATE OR REPLACE keeps the existing on_auth_user_created
-- trigger binding intact. Only affects users created AFTER this runs;
-- existing rows keep whatever reset_at they already have and roll onto the
-- signup-anchored cadence on their next lazy reset.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
declare
  first_reset timestamp with time zone;
  v_plan text := 'free';
  v_credits integer := 20;
begin
  -- [WEEKLY-RESET-ANCHOR] First window ends 7 days from signup (the user's
  -- own signup weekday/time), matching the lazy reset in api/chat.js.
  -- Was date_trunc('week', now() + interval '7 days'), which snapped to Monday.
  first_reset := now() + interval '7 days';

  -- Auto-provision VIRL's attorney with a Pro account (NOT Founder) for legal/risk review.
  -- Pro = plan 'pro' + 150 credits + founding_tier 'standard' (default). No founding slot assigned.
  if lower(new.email) = 'jessee@creativecounsellaw.com' then
    v_plan := 'pro';
    v_credits := 150;
  end if;

  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;

  insert into public.credits (user_id, credits, reset_at, plan)
  values (new.id, v_credits, first_reset, v_plan)
  on conflict (user_id) do nothing;

  return new;
end;
$$;
