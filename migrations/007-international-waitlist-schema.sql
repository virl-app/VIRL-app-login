-- ─────────────────────────────────────────────────────────────────────────────
-- [GEO-GATE] International waitlist table.
--
-- Captures interest from non-US visitors who hit the geo gate (Edge
-- Middleware at /middleware.js → branded "VIRL isn't available outside the
-- US yet" page with email + marketing-consent form → POST
-- /api/international-waitlist → INSERT here).
--
-- Schema notes:
--   - PRIMARY KEY (email) so re-submissions from the same address are
--     no-ops (ON CONFLICT DO NOTHING in the endpoint). First interest
--     timestamp wins; if a user later wants to change consent state
--     they'll use the standard unsubscribe surface once we have one.
--   - country comes from Vercel's x-vercel-ip-country header at request
--     time. May be NULL if Vercel couldn't geolocate.
--   - marketing_opt_in default FALSE matches the GDPR-safe stance from
--     migration 003 (email_preferences) — explicit affirmative action
--     required.
--   - ip_hash is sha256(salt + ip_address) — not stored in the clear, but
--     enough to spot abuse patterns (single IP submitting 100 emails)
--     without retaining PII unnecessarily.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.international_waitlist (
  email             text NOT NULL PRIMARY KEY,
  country           text,
  marketing_opt_in  boolean NOT NULL DEFAULT false,
  ip_hash           text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Cheap aggregation index for "how many signups from each country?" admin
-- queries. The PK on email already covers single-row lookups by email.
CREATE INDEX IF NOT EXISTS idx_international_waitlist_country
  ON public.international_waitlist(country)
  WHERE country IS NOT NULL;
