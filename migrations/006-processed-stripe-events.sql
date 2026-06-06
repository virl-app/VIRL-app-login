-- ─────────────────────────────────────────────────────────────────────────────
-- [STRIPE-IDEMPOTENCY] Stripe webhook event de-duplication table
--
-- Stripe retries any webhook delivery that doesn't return a 2xx — and inner
-- handler logic can throw (Loops timeout, Supabase blip, network blip) AFTER
-- side effects have already run. Without an event-level idempotency guard,
-- side effects re-run on every retry:
--   - credits.resubscription_count increments each time
--   - Loops events (subscriptionStarted, subscriptionCancelled, etc.) fire
--     repeatedly
--   - Resend subscription_welcome dedupe key is per-subscription-id, not
--     per-event, so a single retry doesn't re-send mail but the increments
--     still drift
--
-- Fix: insert event.id into processed_stripe_events at the TOP of the
-- handler with a unique-key conflict path. If insert succeeds → first
-- delivery, process normally. If 409 → Stripe is retrying a delivery
-- we already handled, return 200 immediately so Stripe stops retrying.
--
-- Trade-off: if the handler crashes mid-way (after inserting event_id
-- but before all side effects ran), the retry sees the event as already
-- processed and skips entirely. Half-processed state stays half-processed.
-- This is acceptable because the goal is preventing over-counted
-- side effects — the alternative ("insert at end") risks parallel
-- deliveries of the same event running side effects twice.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.processed_stripe_events (
  event_id     text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Stripe event IDs look like `evt_1OxYz...` and have no natural sort
-- pattern useful for a secondary index. PRIMARY KEY index on event_id
-- covers every lookup the webhook does (existence check, conflict
-- detection). No secondary index needed.
--
-- Optional housekeeping: prune rows older than 30 days. Stripe's retry
-- window is bounded (~72 hours for standard webhook retries), so anything
-- older than a few days is just storage cost. Not added as a migration
-- step — can be added later as a cron / scheduled DELETE if the table
-- grows large enough to matter.
