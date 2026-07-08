-- ─────────────────────────────────────────────────────────────────────────────
-- [BUGFIX/RLS] Add the RLS policies two client-facing tables were missing.
--
-- Both tables had RLS ENABLED but ZERO policies, which denies all access to the
-- anon/authenticated roles — so the client code that reads/writes them (with the
-- public anon key) silently failed:
--
--   * email_preferences — index.html upserts the user's marketing opt-out here
--     at signup. With no INSERT policy the write was rejected, so the opt-out
--     never persisted. The cron mailer + opt-out endpoint treat a MISSING row
--     as "not opted out", so a user who UNCHECKED marketing consent could still
--     receive marketing email. This is a consent-correctness / compliance bug,
--     not just a UX one. Fix: let a user manage their OWN preference row.
--
--   * playbook — the in-app "Algo" tab fetches this global, intentionally-public
--     strategy table with the anon key (loadPlaybook()). With no SELECT policy
--     anon got zero rows and the tab rendered empty. Fix: public read-only.
--     Writes stay server-side (service_role via the admin playbook endpoints).
--
-- Run in the Supabase SQL Editor (idempotent).
-- ─────────────────────────────────────────────────────────────────────────────

-- email_preferences: a user may read/insert/update only their own row.
DROP POLICY IF EXISTS email_preferences_select_own ON public.email_preferences;
DROP POLICY IF EXISTS email_preferences_insert_own ON public.email_preferences;
DROP POLICY IF EXISTS email_preferences_update_own ON public.email_preferences;

CREATE POLICY email_preferences_select_own ON public.email_preferences
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY email_preferences_insert_own ON public.email_preferences
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY email_preferences_update_own ON public.email_preferences
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- playbook: public, read-only. Global strategy data, transparent by design.
DROP POLICY IF EXISTS playbook_public_read ON public.playbook;
CREATE POLICY playbook_public_read ON public.playbook
  FOR SELECT TO anon, authenticated USING (true);
