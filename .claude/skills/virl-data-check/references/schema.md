# VIRL schema map

Only what diagnostics need. For anything else, read the migration that created
it — `migrations/` is numbered and each file explains why the column exists.

There is no ORM anywhere in this codebase. The Node side talks raw PostgREST
over `fetch` (`${SUPABASE_URL}/rest/v1/...`), and the edge function does the
same in Deno. So the table and column names in the code are the real ones, and
grepping for `rest/v1/<table>` finds every reader and writer of it.

## The two trend tables

They are unrelated in schema and easily confused. `virl-trend-dataflow` covers
how they relate at runtime.

### `trends` — weekly research (Perplexity)

Written by `api/cron/trends-refresh.js`, Mondays 07:00 UTC.

| column | notes |
|---|---|
| `platform` | Title case: `TikTok`, `Instagram`, `Facebook`, `YouTube`, `LinkedIn`, `X`, `Pinterest` |
| `segment` | Nine canonical keys, or **NULL for the platform-wide row**. NULL is meaningful, not missing. Added in migration 026 |
| `summary` | One sentence from the model. **Read this before theorizing about empty runs** — it frequently states the cause |
| `items` | jsonb array. Each: `trend`, `category`, `source_url`, `reason` |
| `sources` | jsonb array of URLs, response-level rather than per item |
| `fetched_at` | Insert time. Rows are append-only; there is no update path |

Expected weekly volume: 7 global + 20 segment = 27 rows.

`segment` is constrained to `real_estate`, `coach`, `creator`,
`personal_brand`, `small_business`, `fitness`, `healthcare`, `beauty`, `hair`
— the same keys as `playbook_segments.segment_key` and the keys inside
`trend_items.niche_scores`. Anything predating migration 026 has `segment`
NULL and is genuinely platform-wide research.

### `trend_items` — observed pipeline (measured)

Written **only** by the `ingest-trends` Supabase edge function, Mon + Thu 10:00
UTC. No token, no writes — and no error either.

| column | notes |
|---|---|
| `platform` | lowercase `tiktok`. Note the case difference from `trends` |
| `type` | `hashtag` or `sound` |
| `normalized_name` | Upsert key with platform/type/region |
| `status` | `new`, `rising`, `peaking`, `fading`, `dead` |
| `niche_scores` | jsonb, segment key → float. `_note` rides along here too |
| `context`, `suggested_angles` | Perplexity enrichment, capped at 10 per run |
| `last_seen` | Freshness. **The staleness monitor watches this column** |

### `trend_observations` — append-only history

`trend_item_id`, `observed_at`, `rank`, `views`, `post_count`, `raw`. One row
per trend per ingest run. Lifecycle scoring reads a 30-day window of these; a
trend with a single observation has no measured trajectory whatever its status
says.

## Playbook tables

- `playbook_segments` — `segment_key`, `label`, `compliance_overlay`,
  `platform_priority`. The canonical segment list.
- `platform_playbooks` — `content`, `niche_notes`, `version`. Format and spec
  guidance. Precedence rule: trend data wins on *what* is trending, the
  playbook wins on *format and specs*.
- `playbook_drafts` — admin-reviewed, unlike trends which auto-publish.

## Everything else, briefly

`profiles` (voice samples, pillars, `offLimits`, handles), `credits`,
`plan_jobs`, `plan_history`, `plans`, `content_ratings` (`reason`, `reason_at`
— the thumbs-down chips), `creator_handle_research`, `usage_events`, `events`,
`email_preferences`, `email_sends`, `referrals`, `referral_codes`,
`founding_positions`, `compliance_rules`, `international_waitlist`,
`rate_limit_events`, `processed_stripe_events`, `feedback`, `user_data`.

## Cron schedule

Vercel (`vercel.json`), UTC:

| job | schedule |
|---|---|
| `trends-refresh` | `0 7 * * 1` — Mondays |
| `trend-health` | `0 13 * * *` — daily staleness check |
| `playbook-refresh` | `0 6 1 * *` — monthly |
| `email-triggers` | `0 14 * * *` and `30 23 * * *` |
| `cleanup-rate-limits` | `30 4 * * *` |

`ingest-trends` is **not** here — it runs on Supabase `pg_cron` + `net.http_post`,
Mon + Thu 10:00 UTC, and is authenticated by the `x-ingest-secret` header.
Vercel deploys never touch it; it needs `supabase functions deploy ingest-trends`.

## Two case traps

`trends.platform` is Title case, `trend_items.platform` is lowercase. Joining
or filtering across them without normalizing returns zero rows and looks
exactly like "no data".

`segment IS NULL` is the global tier, not a missing value. `where segment = ...`
silently drops every global row; use `coalesce(segment,'(global)')` when
grouping so the tier stays visible.
