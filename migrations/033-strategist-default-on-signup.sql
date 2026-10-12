-- [ROLLOUT] Every new account starts on the strategist path.
--
-- handle_new_user() (migration 017, locked down in 018) now also writes the
-- account_flags row with strategist_v2 = true, so the four-question
-- interview is the first thing a new account sees. Existing accounts are
-- untouched: their flag stays whatever it is (only Lauren's is on), so
-- nobody mid-stream is moved without a decision.
--
-- The function body is 017's verbatim plus the one insert. CREATE OR REPLACE
-- keeps the on_auth_user_created trigger binding and 018's search_path and
-- EXECUTE revocations intact.
--
-- Run in Supabase SQL Editor. Idempotent.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  first_reset timestamp with time zone;
  v_plan text := 'free';
  v_credits integer := 20;
begin
  -- [WEEKLY-RESET-ANCHOR] First window ends 7 days from signup (the user's
  -- own signup weekday/time), matching the lazy reset in api/chat.js.
  first_reset := now() + interval '7 days';

  -- Auto-provision VIRL's attorney with a Pro account (NOT Founder) for legal/risk review.
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

  -- [STRATEGIST] New accounts start on the strategist path.
  insert into public.account_flags (user_id, strategist_v2)
  values (new.id, true)
  on conflict (user_id) do nothing;

  return new;
end;
$$;
