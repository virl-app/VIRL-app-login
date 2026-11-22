-- [PR D / D1] Capture the production signup trigger in the repo.
--
-- public.handle_new_user() and the on_auth_user_created trigger on auth.users
-- run on every signup. Migration 017 holds an older version of the function;
-- production has since diverged (the account_flags insert was added straight
-- in the dashboard), so the repo no longer described what runs. This file is
-- the function EXACTLY as production has it on 2026-11-22, read with
--   select pg_get_functiondef('public.handle_new_user'::regproc);
-- plus the trigger (pg_get_triggerdef) and the privileges 018 set.
--
-- What it does on each new auth.users row:
--   profiles       insert (id)
--   credits        free plan, 20 credits, first reset 7 days from signup;
--                  one hardcoded email (VIRL's attorney) gets pro + 150
--   account_flags  strategist_v2 = true, so new accounts start on the
--                  strategist path
--
-- BEHAVIOR CHANGE: none. Applying this to production is a no-op. The
-- hardcoded comp email stays as it is (Open decision 6); moving it to a
-- table or env var would be its own change.
--
-- Run in Supabase SQL Editor. Idempotent.

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  first_reset timestamp with time zone;
  v_plan text := 'free';
  v_credits integer := 20;
begin
  first_reset := now() + interval '7 days';

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
$function$;

-- Same lock-down as 018: a trigger function, never callable over the API.
-- (Trigger execution does not check EXECUTE, so the trigger still fires.)
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

-- Production: CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
--             FOR EACH ROW EXECUTE FUNCTION handle_new_user()
-- OR REPLACE (Postgres 14+) keeps this idempotent without dropping the
-- trigger, so there is no moment when a signup could skip it.
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
