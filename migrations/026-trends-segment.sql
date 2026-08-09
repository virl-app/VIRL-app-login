-- ─────────────────────────────────────────────────────────────────────────────
-- [TRENDS-SEGMENT] A segment column on public.trends.
--
-- The weekly research cron calls researchTrends(platform) with no second
-- argument, and researchTrends' own comment is explicit about what that means:
-- the cron path is "global, niche-agnostic". So every row in this table is a
-- platform-wide trend recap.
--
-- That was fine while `trends` only fed the Algo tab, where a creator reads
-- "here is what is moving on TikTok" and applies their own judgment. It stopped
-- being fine when the trend-fallback landed and these same rows began feeding
-- generation, because the fallback applies NO niche filter of any kind — the
-- observed path has niche_scores and a fit floor, the legacy path has neither.
--
-- The result is that a Nashville real estate agent's weekly plan gets built on
-- rows like "the Microwave Challenge is a current behavior-led challenge" and
-- "the Puerto Rico Song lip-sync format is still gaining". Those items are
-- specific, dated, and correctly sourced. They are simply not about her
-- business. The prompt then instructs the model to cite them as "what is being
-- talked about IN THIS NICHE right now" — asserting a relevance the data never
-- had.
--
-- researchTrends has accepted a `niche` option this whole time; the inline
-- per-generation path uses it. Only the cron doesn't. Fixing that needs
-- somewhere to put the answer, which is this column.
--
--   segment — one of the nine canonical segment keys (matching
--             playbook_segments.segment_key and the niche_scores keys on
--             trend_items), or NULL for the platform-wide row.
--
-- NULL is meaningful, not missing: the global row is still written for every
-- platform and still backs the Algo tab, and it is what a creator falls back to
-- when their segment has no fresh row. Existing rows keep NULL and stay valid
-- and useful, which is why this needs no backfill.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.trends
  ADD COLUMN IF NOT EXISTS segment text;

-- The reader asks two questions and this index serves both: "newest row for
-- this segment on this platform" and, with segment IS NULL, "newest global row
-- for this platform". Ordered DESC on fetched_at because every read is
-- most-recent-first and bounded by a freshness window.
CREATE INDEX IF NOT EXISTS trends_segment_platform_fetched_idx
  ON public.trends (segment, platform, fetched_at DESC);

-- Kept as a separate partial index: the global-row lookup is the hot path
-- (it backs the Algo tab and every fallback miss) and stays small, since
-- global rows are a minority once per-segment rows are being written.
CREATE INDEX IF NOT EXISTS trends_global_platform_fetched_idx
  ON public.trends (platform, fetched_at DESC)
  WHERE segment IS NULL;

-- Guard the vocabulary. Segment keys are a contract shared by three places
-- (playbook_segments.segment_key, trend_items.niche_scores, and the resolver
-- in api/_lib/trend-context.js); a typo here would silently produce rows no
-- reader ever matches, which reads downstream as "no trends this week" — the
-- exact disguise this whole line of work keeps finding things hiding behind.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trends_segment_valid'
  ) THEN
    ALTER TABLE public.trends
      ADD CONSTRAINT trends_segment_valid CHECK (
        segment IS NULL OR segment IN (
          'real_estate','coach','creator','personal_brand',
          'small_business','fitness','healthcare','beauty','hair'
        )
      );
  END IF;
END $$;

-- [PostgREST] Schema cache reload so the new column is immediately available
-- to the REST API (same fix as migrations 015/016/023/024/025).
NOTIFY pgrst, 'reload schema';
