-- ─────────────────────────────────────────────────────────────────────────────
-- [COMPLIANCE 1] Niche compliance rules schema migration
--
-- Backs the "compliance language built in" promise on the marketing site for
-- Real Estate and Wellness niches. The schema stores canonical agency
-- sources (HUD, FTC, FDA, NAR) and human-reviewed rules distilled from them.
-- The prompt builder reads only status='approved' rows, so drafts produced
-- by the ingestion cron never reach a user without human review.
--
-- Tables:
--   - compliance_sources: one row per canonical URL (uniqued on
--     niche+locale+category+source_url).
--   - compliance_rules:   distilled, model-ready rules. Versioned per source
--     so a re-pull never overwrites an existing approved row.
--
-- Generation reads compliance_rules WHERE status='approved' ONLY. The
-- partial index keeps that hot-path query cheap. Drafts accumulate until a
-- human in Supabase sets status='approved' and fills reviewed_by/reviewed_at.
--
-- If the DB has no approved rules for an in-scope niche, the loader falls
-- through to a hardcoded safe-defaults floor in api/_lib/compliance.js so
-- behavior never degrades below today's baseline.
--
-- Idempotent — safe to re-run. Run in Supabase SQL Editor against the
-- production database.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 3a. compliance_sources — one row per canonical URL we pull from.
CREATE TABLE IF NOT EXISTS compliance_sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  niche           TEXT NOT NULL CHECK (niche IN ('real_estate','wellness')),
  locale          TEXT NOT NULL DEFAULT 'US',
  category        TEXT NOT NULL,
  agency          TEXT NOT NULL,
  source_url      TEXT NOT NULL,
  last_fetched_at TIMESTAMPTZ,
  last_fetch_etag TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (niche, locale, category, source_url)
);

CREATE INDEX IF NOT EXISTS idx_compliance_sources_niche_locale
  ON compliance_sources(niche, locale);

-- 3b. compliance_rules — distilled, model-ready rules. One row per
-- (source, version). The unique constraint lets the ingestion script
-- INSERT a new draft at version=max+1 without colliding with an existing
-- approved row at version=max.
CREATE TABLE IF NOT EXISTS compliance_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID NOT NULL REFERENCES compliance_sources(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL DEFAULT 1,
  rule_text       TEXT NOT NULL,
  denylist        JSONB NOT NULL DEFAULT '[]'::jsonb,
  compliance_note TEXT,
  source_excerpt  TEXT,
  status          TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','approved','retired')),
  reviewed_by     TEXT,
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, version)
);

-- Hot-path partial index: the loader only ever reads approved rows, so the
-- index lives only on those. Keeps the index small and the read fast even as
-- draft/retired rows accumulate from re-pulls.
CREATE INDEX IF NOT EXISTS idx_compliance_rules_status_niche
  ON compliance_rules(status) WHERE status = 'approved';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries (run separately after the migration).
-- ─────────────────────────────────────────────────────────────────────────────

-- V1. Tables exist.
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN ('compliance_sources','compliance_rules');
-- Expected: 2 rows.

-- V2. Status column has the right CHECK constraint.
-- INSERT INTO compliance_rules (source_id, rule_text, status)
-- VALUES ('00000000-0000-0000-0000-000000000000','test','nonsense');
-- Expected: 23514 (check_violation).

-- V3. Partial index is in place and is partial.
-- SELECT indexdef FROM pg_indexes
-- WHERE indexname = 'idx_compliance_rules_status_niche';
-- Expected: ends in "WHERE status = 'approved'".

-- V4. Distribution of rule statuses (mostly draft until reviewer approves).
-- SELECT status, COUNT(*) FROM compliance_rules GROUP BY status;

-- V5. Highest approved version per (source, niche, locale, category) —
-- mirrors the loader's read path. Useful for spot-checking that the
-- loader sees what you expect after an approval round.
-- SELECT s.niche, s.locale, s.category, s.source_url,
--        MAX(r.version) AS approved_version
-- FROM compliance_sources s
-- JOIN compliance_rules   r ON r.source_id = s.id
-- WHERE r.status = 'approved'
-- GROUP BY s.niche, s.locale, s.category, s.source_url
-- ORDER BY s.niche, s.locale, s.category;

-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback (only if something goes catastrophically wrong).
-- ─────────────────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP TABLE IF EXISTS compliance_rules;
-- DROP TABLE IF EXISTS compliance_sources;
-- COMMIT;
