-- ─────────────────────────────────────────────────────────────────────────────
-- [PROFILE-SALES-FIELDS] Five new text columns on profiles for the
-- service-business audience (real estate agents, dental practices,
-- coaches, fitness pros, small business owners) — the creators whose
-- content needs to convert, not just entertain.
--
-- The original Profile didn't capture these signals at all. Generated
-- content kept defaulting to "build awareness / community" framing
-- because that's what the Voice / Audience / Topics fields surfaced.
-- These five give the prompt-builder concrete material to ground a
-- sales-oriented post in: what you actually offer, where you serve,
-- who your ideal client is + what hurts, your CTA pattern, and the
-- objections you keep hearing.
--
--   offerings              — what they sell (services / packages /
--                            products). Lets the model name real
--                            offerings instead of inventing them.
--   service_area           — geographic focus for local businesses
--                            (agents, dentists, fitness studios).
--                            Stops content from referencing the wrong
--                            city / market.
--   ideal_client_problem   — sharper companion to `audience`. "Who
--                            is your audience" is broad; this asks
--                            "what specific problem do they have
--                            when they find you?" — content can then
--                            speak directly to that pain.
--   primary_cta            — default close pattern ("DM 'GUIDE' for
--                            the first-time buyer roadmap"). Drives
--                            consistent CTAs across generations.
--   common_objections      — objections the creator hears most. Gives
--                            content a job to do: resolve these in
--                            generated copy.
--
-- All five are TEXT and default NULL. None counts against profile
-- tier completeness — personal-brand creators leave them blank without
-- penalty. The prompt-builder skips any empty field cleanly (same
-- pattern as inspiration, business_website).
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS offerings            text,
  ADD COLUMN IF NOT EXISTS service_area         text,
  ADD COLUMN IF NOT EXISTS ideal_client_problem text,
  ADD COLUMN IF NOT EXISTS primary_cta          text,
  ADD COLUMN IF NOT EXISTS common_objections    text;

-- [PostgREST] Schema cache reload so the new columns are immediately
-- available to the REST API (without this, the first save after the
-- ALTER will hit "Could not find the column in the schema cache" until
-- PostgREST's lazy refresh catches up — same fix we needed for
-- business_website in migration 015).
NOTIFY pgrst, 'reload schema';
