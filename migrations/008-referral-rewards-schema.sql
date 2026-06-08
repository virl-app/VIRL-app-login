-- ─────────────────────────────────────────────────────────────────────────────
-- [REFERRAL-REWARDS] Schema for the referral-rewards program.
--
-- Mechanic: when a friend signs up via a referrer's link (?ref=ABCDEFGH) AND
-- completes Stripe checkout, the referrer gets a Stripe coupon applied to
-- their next subscription invoice. Cap: 2 redemptions per referrer.
--
-- This file ships:
--   1. public.referral_rewards table — one row per successful reward
--   2. public.lookup_user_by_referral_code RPC — maps the 8-char prefix
--      stored in user_metadata.ref back to a full auth.users.id
--
-- The actual reward fulfillment lives in api/stripe-webhook.js
-- (checkout.session.completed branch). This migration is just the
-- persistence layer.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.referral_rewards (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  -- The user who referred (will receive the discount).
  referrer_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The friend who was referred (the new subscriber).
  referred_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The Stripe coupon used (env STRIPE_REFERRAL_COUPON_ID). Stored for audit
  -- so swapping the coupon later is traceable.
  stripe_coupon_id  text NOT NULL,
  -- Whether the Stripe API call to apply the coupon succeeded. We record
  -- the reward either way (so the cap counts attempted grants), but track
  -- the apply status so a failed Stripe call can be retried manually.
  applied_to_stripe boolean NOT NULL DEFAULT false,
  apply_error       text, -- truncated error message if applied_to_stripe = false
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- One reward per referred signup. If a Stripe webhook replays (shouldn't,
  -- given the processed_stripe_events guard, but belt-and-braces) the second
  -- insert hits this constraint and the webhook handler skips silently.
  UNIQUE (referred_user_id)
);

-- Lookup pattern is "count rewards per referrer" for the cap check + "list
-- rewards for a referrer" for the future UI tile showing "X of 2 redeemed."
CREATE INDEX IF NOT EXISTS idx_referral_rewards_referrer
  ON public.referral_rewards(referrer_user_id);

-- ── RPC: lookup_user_by_referral_code ───────────────────────────────────────
-- The client stores the referrer's 8-character ID prefix in
-- auth.users.user_metadata.ref (e.g. "abc12345"). The webhook needs to map
-- that prefix back to the full UUID. auth.users isn't directly queryable
-- via PostgREST, so we expose a SECURITY DEFINER function that the webhook
-- calls with the service role key.
--
-- Collision risk: 8 hex chars = 16^8 = ~4.3 billion combinations. With
-- 1000s of users, collision probability is negligible. If it ever happens,
-- LIMIT 1 picks the first match (deterministic, not random).
CREATE OR REPLACE FUNCTION public.lookup_user_by_referral_code(p_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF p_code IS NULL OR length(p_code) < 4 THEN
    RETURN NULL;
  END IF;
  SELECT id INTO v_user_id
  FROM auth.users
  WHERE id::text LIKE p_code || '%'
  LIMIT 1;
  RETURN v_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_user_by_referral_code(text) TO service_role;
