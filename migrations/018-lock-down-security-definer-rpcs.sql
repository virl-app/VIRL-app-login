-- ─────────────────────────────────────────────────────────────────────────────
-- [SECURITY] Lock down SECURITY DEFINER RPCs to service_role only.
--
-- consume_credit, claim_founding_position, and check_and_record_rate_limits are
-- SECURITY DEFINER functions that were EXECUTE-granted to PUBLIC / anon /
-- authenticated (the default for any function unless revoked). Because they take
-- `p_user_id` as a PARAMETER — not `auth.uid()` — and run as the table owner
-- (RLS does not apply inside a SECURITY DEFINER function), ANY caller with the
-- public anon key could invoke them directly via PostgREST `/rest/v1/rpc/*`
-- against an ARBITRARY user id:
--
--   * consume_credit(victim, 999999, false)        → drain any user's weekly
--                                                    credits to zero (griefing)
--   * claim_founding_position(any_uuid)            → burn the 50 scarce Founder
--                                                    Circle slots, or self-assign
--                                                    a slot without ever paying
--   * check_and_record_rate_limits(victim, 'chat') → inflate a victim's rate-
--                                                    limit counters to lock them
--                                                    out of /api/chat (DoS)
--
-- Every legitimate caller is a server endpoint that authenticates to Supabase
-- with the SERVICE key and therefore runs as `service_role`
-- (api/chat.js → consume_credit + check_and_record_rate_limits,
--  api/stripe-webhook.js → claim_founding_position). The browser SPA never
-- calls these RPCs directly (verified: no /rpc/ references in index.html).
-- Revoking EXECUTE from PUBLIC/anon/authenticated closes the hole with ZERO
-- impact on the running app. Reversible: re-GRANT to restore.
--
-- Also:
--   * Pins the mutable search_path on the two functions that lacked it
--     (defense-in-depth against search_path hijacking of a definer function).
--   * Revokes direct RPC execute on the internal trigger functions
--     handle_new_user() and rls_auto_enable() — they fire from triggers as the
--     table owner and are never meant to be called over the REST API. (Trigger
--     execution does not check EXECUTE privilege, so this is safe.)
--
-- Run in the Supabase SQL Editor (idempotent).
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.consume_credit(uuid, integer, boolean)                       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_founding_position(uuid)                                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_and_record_rate_limits(uuid, text, integer, integer)    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user()                                             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable()                                             FROM PUBLIC, anon, authenticated;

-- Assert the one role the app actually uses retains access.
GRANT EXECUTE ON FUNCTION public.consume_credit(uuid, integer, boolean)                    TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_founding_position(uuid)                             TO service_role;
GRANT EXECUTE ON FUNCTION public.check_and_record_rate_limits(uuid, text, integer, integer) TO service_role;

-- Pin search_path on the two SECURITY DEFINER functions flagged as mutable.
-- Both reference their tables schema-qualified (public.*), so `public` is safe.
ALTER FUNCTION public.check_and_record_rate_limits(uuid, text, integer, integer) SET search_path = public;
ALTER FUNCTION public.handle_new_user()                                          SET search_path = public;
