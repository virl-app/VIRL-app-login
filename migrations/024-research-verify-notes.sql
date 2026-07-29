-- ─────────────────────────────────────────────────────────────────────────────
-- [RESEARCH-VERIFY] verify_notes column on creator_handle_research.
--
-- Every channel-research brief now passes through a verification step
-- (api/_lib/research-verify.js) before it is cached, shown to the creator,
-- or fed to any prompt. That step fact-checks the brief against what the
-- creator has actually told us — their own business website, their own
-- handles, their own corrections — deletes claims that conflict, deletes
-- speculation the research hedged on, and strips filler.
--
-- verify_notes stores the summary of that audit alongside the text it
-- produced:
--
--   {
--     checked:          bool,     -- did the model pass run, or only the
--                                 -- deterministic guards? (drives whether
--                                 -- the UI may claim the brief was checked)
--     removedCount:     int,
--     removed:          text[],   -- short human-readable reasons, shown
--                                 -- verbatim to the creator
--     identityConflict: bool,     -- a claim contradicted stated identity —
--                                 -- the wrong-business-name failure
--     foreignDomains:   text[],   -- domains the hard guard dropped
--     verifiedAt:       timestamp
--   }
--
-- It lives on the cache row rather than being recomputed because the audit
-- is paid for once per research refresh (30-day TTL), while the Profile
-- panel reads the brief on every visit — and a creator who saw "VIRL threw
-- out 2 claims it couldn't verify" once should keep seeing it, not have it
-- vanish on reload.
--
-- jsonb, nullable. Rows written before this migration return NULL, which
-- the client renders as "not checked yet" rather than as a verified badge
-- it hasn't earned. api/_lib/handle-research.js writes the column
-- defensively (retries the upsert without it on failure), so a deploy that
-- lands ahead of this migration degrades to un-annotated cache writes
-- instead of losing them.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.creator_handle_research
  ADD COLUMN IF NOT EXISTS verify_notes jsonb;

-- [PostgREST] Schema cache reload so the new column is immediately
-- available to the REST API (same fix as migrations 015/016/023).
NOTIFY pgrst, 'reload schema';
