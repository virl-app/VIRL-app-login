-- [PR D / D2] Clear the Supabase performance advisor's RLS and FK findings.
--
-- Three things, nothing else (unused indexes, the 18 "RLS enabled, no policy"
-- notices, citext/pg_net in public are deliberately left alone):
--
-- 1. auth_rls_initplan (35 policies). A bare auth.uid() / auth.role() in a
--    policy is re-evaluated for every row. Wrapped as (select auth.uid()) it
--    is evaluated once per query (an initPlan). Same result, same rows. Done
--    with ALTER POLICY, so each policy keeps its name, command and roles;
--    only the expressions change. The 31 that stay are listed below; the 4
--    duplicates in (2) are dropped instead.
--
-- 2. multiple_permissive_policies (20 findings, 2 sets of duplicates). Both
--    sets were made in the dashboard; no migration creates them. Each pair
--    was compared in pg_policies on 2026-11-22: same table, command, roles
--    ({public}) and expression.
--      credits SELECT   "Users can read own credits" = "Users can view own credits"
--                       both USING (auth.uid() = user_id). Keep "view".
--      profiles INSERT  "Users can insert own profile" = profiles_insert_own
--                       both WITH CHECK (auth.uid() = id). Keep profiles_insert_own.
--      profiles SELECT  "Users can view own profile" = profiles_select_own
--                       both USING (auth.uid() = id). Keep profiles_select_own.
--      profiles UPDATE  "Users can update own profile" USING (auth.uid() = id),
--                       no WITH CHECK; profiles_update_own USING and WITH CHECK
--                       (auth.uid() = id). Postgres uses USING as the check when
--                       WITH CHECK is absent, so they allow exactly the same
--                       updates. Keep profiles_update_own (explicit).
--    Permissive policies are OR-ed, so dropping an identical twin changes
--    nothing a user can see or do.
--
-- 3. unindexed_foreign_keys (4). Plain CREATE INDEX: the tables are small,
--    so the brief lock is not worth CONCURRENTLY (which cannot run inside the
--    SQL editor's transaction).
--
-- Run in Supabase SQL Editor, on a branch first. Idempotent: re-running it
-- re-applies the same expressions; the drops and indexes use IF (NOT) EXISTS.

BEGIN;

-- 2. Duplicate permissive policies
DROP POLICY IF EXISTS "Users can read own credits" ON public.credits;
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;

-- 1. auth.<fn>() evaluated once per query

-- account_flags
ALTER POLICY "account_flags_select_own" ON public.account_flags USING (((select auth.uid()) = user_id));

-- credits
ALTER POLICY "Users can view own credits" ON public.credits USING (((select auth.uid()) = user_id));

-- email_preferences
ALTER POLICY "email_preferences_insert_own" ON public.email_preferences WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY "email_preferences_select_own" ON public.email_preferences USING (((select auth.uid()) = user_id));
ALTER POLICY "email_preferences_update_own" ON public.email_preferences USING (((select auth.uid()) = user_id)) WITH CHECK (((select auth.uid()) = user_id));

-- events
ALTER POLICY "Users can insert own events" ON public.events WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY "Service role can read all events" ON public.events USING (((select auth.role()) = 'service_role'::text));

-- plan_history
ALTER POLICY "plan_history_delete_own" ON public.plan_history USING (((select auth.uid()) = user_id));
ALTER POLICY "plan_history_insert_own" ON public.plan_history WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY "plan_history_select_own" ON public.plan_history USING (((select auth.uid()) = user_id));
ALTER POLICY "plan_history_update_own" ON public.plan_history USING (((select auth.uid()) = user_id)) WITH CHECK (((select auth.uid()) = user_id));

-- plan_jobs
ALTER POLICY "plan_jobs_select_own" ON public.plan_jobs USING ((user_id = (select auth.uid())));

-- plans
ALTER POLICY "plans_delete_own" ON public.plans USING (((select auth.uid()) = user_id));
ALTER POLICY "plans_upsert_own" ON public.plans WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY "plans_select_own" ON public.plans USING (((select auth.uid()) = user_id));
ALTER POLICY "plans_update_own" ON public.plans USING (((select auth.uid()) = user_id));

-- posts
ALTER POLICY "posts_insert_own" ON public.posts WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY "posts_select_own" ON public.posts USING (((select auth.uid()) = user_id));
ALTER POLICY "posts_update_own" ON public.posts USING (((select auth.uid()) = user_id)) WITH CHECK (((select auth.uid()) = user_id));

-- profiles
ALTER POLICY "profiles_insert_own" ON public.profiles WITH CHECK (((select auth.uid()) = id));
ALTER POLICY "profiles_select_own" ON public.profiles USING (((select auth.uid()) = id));
ALTER POLICY "profiles_update_own" ON public.profiles USING (((select auth.uid()) = id)) WITH CHECK (((select auth.uid()) = id));

-- results
ALTER POLICY "Users manage own results" ON public.results USING (((select auth.uid()) = user_id));

-- strategy_reviews
ALTER POLICY "strategy_reviews_select_own" ON public.strategy_reviews USING (((select auth.uid()) = user_id));

-- user_data
ALTER POLICY "user_data_delete_own" ON public.user_data USING (((select auth.uid()) = user_id));
ALTER POLICY "user_data_upsert_own" ON public.user_data WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY "user_data_select_own" ON public.user_data USING (((select auth.uid()) = user_id));
ALTER POLICY "user_data_update_own" ON public.user_data USING (((select auth.uid()) = user_id));

-- vault
ALTER POLICY "Users manage own vault" ON public.vault USING (((select auth.uid()) = user_id));

-- voice_checks
ALTER POLICY "voice_checks_insert_own" ON public.voice_checks WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY "voice_checks_select_own" ON public.voice_checks USING (((select auth.uid()) = user_id));

-- 3. Covering indexes for foreign keys
CREATE INDEX IF NOT EXISTS feedback_user_id_idx           ON public.feedback (user_id);
CREATE INDEX IF NOT EXISTS playbook_drafts_reviewed_by_idx ON public.playbook_drafts (reviewed_by);
CREATE INDEX IF NOT EXISTS results_user_id_idx            ON public.results (user_id);
CREATE INDEX IF NOT EXISTS vault_user_id_idx              ON public.vault (user_id);

COMMIT;
