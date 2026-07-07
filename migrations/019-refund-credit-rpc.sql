-- ─────────────────────────────────────────────────────────────────────────────
-- [RELIABILITY] refund_credit — atomic compensating add-back for a credit that
-- consume_credit already deducted when the generation then fails upstream.
--
-- api/chat.js consumes a credit BEFORE calling Anthropic (so the wallet gates
-- the expensive call). Previously, if Anthropic returned an error or the stream
-- was interrupted, the endpoint returned 500 and the credit stayed spent — a
-- free/trial user was charged for a generation they never received, every time
-- the provider had a blip. This function lets the server hand that credit back.
--
-- Only ever invoked by the server (service_role) with the exact cost it just
-- deducted, and only for strict/free users whose deduction was exact (paid
-- users float at 0 in lenient mode, so a refund could over-credit them — the
-- caller guards on !isPaid). Locked to service_role like the other credit RPCs.
--
-- Run in the Supabase SQL Editor (idempotent).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.refund_credit(p_user_id uuid, p_amount int)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_balance int;
BEGIN
  IF p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN NULL;
  END IF;
  UPDATE public.credits
     SET credits = credits + p_amount
   WHERE user_id = p_user_id
   RETURNING credits INTO v_new_balance;
  RETURN v_new_balance;  -- NULL when no credits row exists for the user
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refund_credit(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.refund_credit(uuid, int) TO service_role;
