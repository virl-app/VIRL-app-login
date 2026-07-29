-- ─────────────────────────────────────────────────────────────────────────────
-- [REACTION-LOOP] reason columns on content_ratings.
--
-- The one-tap reaction chips that appear after a thumbs-down — "Too formal",
-- "Not my words", "Wrong energy" — were a dead end. They POSTed to the
-- `feedback` support table (alongside sentiment:"negative", which isn't in
-- that endpoint's allowed set, so it was stored as NULL), and nothing ever
-- read them back into generation. The UI said "Noted — I'll learn from
-- this," which was not true.
--
-- The chip is not support correspondence. It is the creator answering the
-- question "what was wrong with this draft?" about one specific draft they
-- already thumbs-downed — which makes it an attribute of the rating, not a
-- separate record. So it lives on the rating row:
--
--   reason     — the chip label, constrained to the vocabulary the server
--                owns (api/rate.js ALLOWED_REASONS). Free text is NOT
--                accepted here; the closed set is what makes the signal
--                aggregatable and safe to feed into a prompt.
--   reason_at  — when the chip was tapped, so the prompt-side reader can
--                weight recent reactions and let stale ones age out. Kept
--                separate from created_at because the rating and the chip
--                are two different moments, and because an upsert on
--                re-rate would otherwise blur them.
--
-- Clearing a rating deletes the row, which takes the reason with it — the
-- correct semantics: a creator who un-downvotes a draft has withdrawn the
-- complaint, and it should stop steering their generations.
--
-- Both nullable. Every existing rating row stays valid with NULL reason and
-- is simply skipped by the reader (api/_lib/voice-reactions.js).
--
-- Run in Supabase SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.content_ratings
  ADD COLUMN IF NOT EXISTS reason    text,
  ADD COLUMN IF NOT EXISTS reason_at timestamptz;

-- Reader pattern is "this user's recent reasons, newest first", so the
-- partial index covers exactly the rows it scans and stays small — the
-- vast majority of rating rows carry no reason at all.
CREATE INDEX IF NOT EXISTS content_ratings_user_reason_idx
  ON public.content_ratings (user_id, reason_at DESC)
  WHERE reason IS NOT NULL;

-- [PostgREST] Schema cache reload so the new columns are immediately
-- available to the REST API (same fix as migrations 015/016/023/024).
NOTIFY pgrst, 'reload schema';
