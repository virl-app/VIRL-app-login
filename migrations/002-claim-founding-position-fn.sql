-- ─────────────────────────────────────────────────────────────────────────────
-- [PRICING 1] Atomic position-claim function for the Founder Circle webhook.
--
-- The stripe-webhook.js handler calls this RPC to assign a founding_position
-- when a Founder Circle checkout completes. The function:
--
--   1. Returns the user's existing position if they already hold one
--      (idempotent — safe for Stripe webhook retries).
--   2. Otherwise atomically claims the lowest-numbered empty position
--      using FOR UPDATE SKIP LOCKED so concurrent webhooks never collide.
--   3. Returns NULL if all 50 positions are filled (documented overflow
--      race window per the brief — caller still sets founding_tier but
--      leaves founding_position NULL).
--
-- Run in Supabase SQL Editor against the production database.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.claim_founding_position(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_position INTEGER;
BEGIN
  -- Idempotent path: user already has a position? Return it unchanged.
  SELECT fp.position INTO v_position
  FROM public.founding_positions fp
  WHERE fp.user_id = p_user_id
  LIMIT 1;

  IF v_position IS NOT NULL THEN
    RETURN v_position;
  END IF;

  -- Atomic claim: lock the lowest empty row, update it, return the number.
  -- FOR UPDATE SKIP LOCKED makes concurrent callers race past each other
  -- to the next available row instead of blocking + double-claiming.
  UPDATE public.founding_positions
  SET user_id   = p_user_id,
      filled_at = NOW()
  WHERE position = (
    SELECT inner_fp.position
    FROM public.founding_positions inner_fp
    WHERE inner_fp.filled_at IS NULL
    ORDER BY inner_fp.position ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING position INTO v_position;

  RETURN v_position;  -- NULL if all 50 positions were already filled
END;
$$;

-- Service role bypasses RLS and can call this directly via the PostgREST RPC
-- endpoint at /rest/v1/rpc/claim_founding_position. No additional grants
-- needed for the webhook caller.

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (run separately after creating the function).
-- ─────────────────────────────────────────────────────────────────────────────
-- V1. Function exists.
-- SELECT proname, pronargs FROM pg_proc WHERE proname = 'claim_founding_position';

-- V2. Smoke test against a dummy UUID (will claim position 1 if empty).
-- SELECT public.claim_founding_position('00000000-0000-0000-0000-000000000001'::uuid);

-- V3. Calling again with the same UUID returns the SAME position (idempotent).
-- SELECT public.claim_founding_position('00000000-0000-0000-0000-000000000001'::uuid);

-- V4. Cleanup test claim before going live.
-- UPDATE public.founding_positions
-- SET user_id = NULL, filled_at = NULL
-- WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid;
