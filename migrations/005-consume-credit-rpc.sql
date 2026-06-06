-- ─────────────────────────────────────────────────────────────────────────────
-- [ATOMIC-CREDITS] Atomic credit deduction RPC
--
-- Replaces the non-atomic read-then-write pattern in api/chat.js that lets
-- parallel /api/chat requests double-spend credits. Two simultaneous calls
-- would both read credits=N, both compute N-cost, both PATCH that value,
-- and both proceed to Anthropic. With this RPC, the conditional decrement
-- happens inside a single UPDATE so only one of the parallel callers wins.
--
-- Two modes:
--   STRICT (free users)  — UPDATE only when credits >= cost. Returns NEW
--                          balance, or NULL if credits insufficient. Caller
--                          translates NULL into HTTP 402.
--   LENIENT (paid non-Pro) — UPDATE always, floor at 0. Returns new balance.
--                          Pro is skipped client-side (unmetered tier).
--
-- Run in Supabase SQL Editor. Idempotent (CREATE OR REPLACE).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.consume_credit(
  p_user_id uuid,
  p_cost    int,
  p_strict  boolean
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_balance int;
BEGIN
  -- Reject obvious garbage early so callers don't have to.
  IF p_user_id IS NULL OR p_cost IS NULL OR p_cost < 0 THEN
    RETURN NULL;
  END IF;

  IF p_strict THEN
    -- Free/trial: only decrement when the balance covers the cost. The
    -- WHERE clause is what makes this race-safe — Postgres locks the row
    -- for the update, so two concurrent calls serialize and the second
    -- one's WHERE evaluates against the already-decremented balance.
    UPDATE public.credits
       SET credits = credits - p_cost
     WHERE user_id = p_user_id
       AND credits >= p_cost
     RETURNING credits INTO v_new_balance;
    -- NULL when:
    --   - No row matched (user has no credits row), OR
    --   - The credits >= p_cost predicate failed (insufficient balance)
    -- Caller's contract: NULL → HTTP 402, integer → success.
    RETURN v_new_balance;
  END IF;

  -- Lenient (paid non-Pro): always decrement, floor at 0. Mirrors the
  -- existing Math.max(0, credits - cost) semantics from the old PATCH —
  -- a paid user past their quota still gets the generation, the counter
  -- just stays at 0 until the weekly reset refills it.
  UPDATE public.credits
     SET credits = GREATEST(credits - p_cost, 0)
   WHERE user_id = p_user_id
   RETURNING credits INTO v_new_balance;
  RETURN v_new_balance;
END;
$$;

-- Grant execute to authenticated + anon. The function is SECURITY DEFINER
-- so it runs as the owner; the caller's RLS doesn't apply. The chat.js
-- endpoint authenticates the request and passes the verified user_id, so
-- this is safe — Supabase service_key (which chat.js uses) can call any
-- function regardless of grant, but listing the grants makes intent
-- explicit and lets a future direct-from-client call work without changes.
GRANT EXECUTE ON FUNCTION public.consume_credit(uuid, int, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consume_credit(uuid, int, boolean) TO service_role;
