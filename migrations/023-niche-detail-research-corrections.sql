-- ─────────────────────────────────────────────────────────────────────────────
-- [NICHE-DETAIL + RESEARCH-CORRECTIONS] Two text columns on profiles.
--
--   niche_detail — the creator's own words on what exactly they do and
--     who pays them. The niche dropdown is a broad label ("Real Estate"
--     covers listing agents, investors, stagers, and lenders whose
--     winning strategies differ); this field is the precise definition.
--     The prompt-builder treats it as the authoritative scope for
--     topics, offers, and strategy within the niche bucket.
--
--   research_corrections — the creator's corrections to the machine-
--     gathered channel research (creator_handle_research). The research
--     paragraph is Perplexity-sourced and can be partially wrong
--     (same-name account confusion, stale reads, sparse profiles).
--     Instead of letting a wrong observation steer generations for up
--     to 30 days, the Profile panel now shows the research and lets the
--     creator type corrections. Corrections are injected into every
--     prompt AFTER the observed-patterns block with explicit override
--     precedence, and they persist across research re-fetches — which
--     is why they live on profiles, not on the research cache row.
--
-- Both TEXT, default NULL, optional, skipped cleanly by the prompt
-- builder when empty (same pattern as migration 016's fields). Neither
-- counts toward profile tier completeness.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS niche_detail         text,
  ADD COLUMN IF NOT EXISTS research_corrections text;

-- [PostgREST] Schema cache reload so the new columns are immediately
-- available to the REST API (same fix as migrations 015/016).
NOTIFY pgrst, 'reload schema';
