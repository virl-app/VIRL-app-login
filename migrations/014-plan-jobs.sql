-- ─────────────────────────────────────────────────────────────────────────────
-- [PLAN-JOB-RECOVERY] Per-generation row that persists the result of a
-- streaming plan generation so the client can recover from a dropped SSE
-- connection.
--
-- Background: VIRL's plan generation is a streaming SSE call. Mobile
-- browsers kill SSE connections when the tab is backgrounded or the
-- screen sleeps, which used to leave users on "Stream interrupted —
-- tap Generate again" while Anthropic had actually finished the call
-- on the server (and we'd already been billed for it).
--
-- The new flow:
--   1. Client generates a planJobId (UUID v4) before POSTing /api/chat
--      and includes it in params.
--   2. Server inserts a plan_jobs row with status='running' at the
--      start of the stream.
--   3. When the upstream completes (success or error), the server
--      UPDATEs the row with status='complete' + result_text, or
--      status='error' + error_msg.
--   4. If the client's SSE dropped, it polls GET /api/plan-status?id=
--      until status flips to complete or error, then renders normally.
--
-- Schema notes:
--   - id is the client-generated UUID. We trust the client to generate
--     a unique value; collisions are astronomically unlikely and the
--     primary-key INSERT would fail loudly anyway.
--   - user_id is the authenticated user. NEVER set from the request
--     body — the server resolves it from the Supabase bearer token.
--   - status is a small enum: running / complete / error.
--   - result_text holds the raw model output (JSON string). The
--     client parses it client-side just like it parses the streaming
--     deltas, so the recovered render path is identical to the
--     streaming render path.
--   - usage is a small JSON blob mirroring meta.usage in the streaming
--     wire format so the recover path can hydrate the same client
--     state (cost, model, token counts) as the streaming path.
--   - trends_snapshot + used_fresh_trends ride along so a regen
--     after a recovered plan reuses the same Perplexity snapshot.
--   - Jobs are short-lived telemetry, not persisted plan content.
--     The plans table is still the canonical store. Expect to GC
--     plan_jobs rows older than 24 hours via a follow-up cron (or
--     just let the table grow — it'll be tiny in practice).
--
-- RLS: users can only see their own job rows. Server writes via the
-- service key bypass RLS.
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.plan_jobs (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  generation_type   text NOT NULL,
  status            text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'complete', 'error')),
  result_text       text,
  error_msg         text,
  cost              integer,
  usage             jsonb,
  trends_snapshot   jsonb,
  used_fresh_trends boolean,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);

-- Lookup pattern: "find this user's most recent in-flight job" and
-- "find this specific job by id." Both want user_id + id or
-- user_id + status + created_at — the index below covers both via the
-- prefix rule.
CREATE INDEX IF NOT EXISTS idx_plan_jobs_user_created
  ON public.plan_jobs(user_id, created_at DESC);

ALTER TABLE public.plan_jobs ENABLE ROW LEVEL SECURITY;

-- Users can SELECT their own rows. INSERT/UPDATE happen via the
-- service-role server only, so no policies for those — the service
-- key bypasses RLS entirely.
DROP POLICY IF EXISTS plan_jobs_select_own ON public.plan_jobs;
CREATE POLICY plan_jobs_select_own ON public.plan_jobs
  FOR SELECT
  USING (user_id = auth.uid());
