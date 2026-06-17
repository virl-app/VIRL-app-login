-- ─────────────────────────────────────────────────────────────────────────────
-- [BUSINESS-WEBSITE] Add a single text column to profiles for the
-- creator's business / brand website URL.
--
-- Why: small-business creators (real estate agents, dental practices,
-- wellness coaches, agency clients) often have a brand site beyond
-- their social handles. The site is the source of truth for what
-- services they actually offer, brand voice in long-form copy, and
-- the canonical destination in CTAs. Letting users surface it lets
-- prompts.js inject the URL into the system prompt so generated
-- content can reference the right product/service names and link
-- back to the right place.
--
-- Intentionally a single column (not a list, not a JSONB). One
-- primary business site is the realistic shape — anyone with
-- multiple should put the main one here.
--
-- NOT required for profile completeness. Plenty of creators are
-- personal-brand only (no business site). The client-side
-- nextSharperField helper does not include this field in its tier
-- gating; this column is purely additive context.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS business_website text;
