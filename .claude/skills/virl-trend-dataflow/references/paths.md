# The two paths, filter by filter

Everything below is in `api/_lib/trend-context.js` unless noted. Line numbers
drift; the function and constant names are stable.

## Entry

`buildTrendContext({ platforms, niche, profile, goal, goalSecondary })`, called
from `api/chat.js` per generation. Returns `{ block, snapshot, usedTrends }`.

`snapshot` is a contract, not a debug field: the client's verifier builds an
allow-list from `snapshot.items[].display_name` and strips any trend cited in
the plan that is missing from it. An item in the block but absent from the
snapshot gets deleted from the creator's plan. Keep them in step.

`resolveSegment(niche, profile)` bridges the user-facing niche label (17
values) to the nine canonical segment keys, with a profile-text pass that
rescues `hair` and `personal_brand` — the picker cannot express those — before
defaulting to `creator`.

## Path A — observed (`trend_items`)

Runs first. Wins whenever it returns anything.

1. **Platforms.** Requested platforms **plus `FALLBACK_PLATFORM` (`tiktok`)**,
   always. A trend peaking on TikTok is legitimate input for a Reels target;
   the renderer labels off-platform items so the model adapts rather than
   claiming the trend is native to the creator's platform.
2. **Freshness.** `last_seen` within `TREND_FRESHNESS_DAYS` (7). Generation
   refuses anything older, which is why the observed staleness alert fires at 5
   — two days of runway.
3. **Fit floor.** `niche_scores[segment] >= FIT_FLOOR` (0.6).
4. **Off-limits.** Hard exclusion on `profile.offLimits`. Enforced in code
   because a boundary enforced by asking a model nicely is not enforced.
   Plural-folded on both sides, since "no politics, elections" must match
   "election day" — a boundary that fails on a plural is not a boundary.
5. **Rank.** Rising ahead of peaking, then fit, nudged by overlap with the
   creator's stated pillars. The pillar bonus is a tiebreak and never outranks
   a real fit gap.
6. **Cap.** `MAX_TRENDS` (5).

Items carry lifecycle status, real external URLs, Perplexity context and
suggested angles.

## Path B — research fallback (`trends`)

Runs only when path A returns zero items.

1. **Tiers.** Reads both the creator's `segment` rows and global rows
   (`segment IS NULL`) in one round trip. **A segment row beats a global row
   for the same platform even when older** — inside the freshness window, being
   about her business beats being published this morning.
2. **Cross-segment guard.** A row belonging to a different segment is rejected
   in code, not merely excluded by the query. A foreign segment row carries no
   marker distinguishing it from a global row, so if the query filter ever
   drifted it would be served as platform-wide research. The guarantee belongs
   to the function, not to a URL built elsewhere in the same file.
3. **Platforms.** Requested platforms, plus `tiktok` **only if the TikTok row
   is a segment row**. This is the rule most often misremembered. A global
   TikTok row served to a YouTube creator is wrong about the industry and the
   platform — two layers of imprecision, which `check-strategist` has asserted
   against since before segments existed. A segment row costs one layer, the
   platform, which is the trade path A makes deliberately. The old assertion
   still passes unmodified; the rule became conditional, not absent.
4. **Freshness.** `LEGACY_TREND_FRESHNESS_DAYS` (14) — two cron cycles of
   slack. Past 14 days the fallback returns nothing and every surface goes
   dark, which is why the legacy staleness alert fires at 10.
5. **Categories.** `topic`, `audio`, `format`, `hook`, `hashtag`.
6. **Off-limits.** Same hard exclusion as path A. Historically this path had no
   filtering of any kind, which mattered most because it runs precisely when
   the observed pipeline is dark — a stated boundary should not depend on which
   pipeline is up.
7. **Interleave.** The creator's own platforms are seeded first so the fallback
   fills after them; otherwise the lead item is whichever platform published
   most recently, which on a thin week opens a YouTube creator's block with a
   TikTok trend.
8. **Cap.** `MAX_TRENDS` (5).

Items carry **no lifecycle status** and must never be given one.

### Provenance, three states

Because a batch can mix tiers, the claim made about it follows what is actually
being served — computed over the items that survived the cap, not over what was
fetched:

- **all segment rows** → "researched for this creator's industry"
- **mixed** → says so, and the renderer marks the platform-wide items
  individually, so the general ones cannot borrow the specific ones'
  credibility
- **all global** → "PLATFORM-WIDE research, not specific to this creator's
  industry"

This line previously asserted "in this niche" unconditionally while the cron
researched niche-agnostically — the prompt claimed a relevance the data never
had, and the model repeated it downstream in good faith.

## The research prompt

`api/_lib/trends-research.js`. `researchTrends(platform, { niche, excludeTrends })`.

**Per-platform frames.** What counts as a trend is not the same everywhere, and
the prompt assumed it was. The generic wording describes short-form video
exactly — micro-trends, sounds, formats. Measured against `quiet_weeks`, five
of seven platforms were mostly refusing to answer it. X, LinkedIn, YouTube,
Pinterest and Facebook each have their own surface list; TikTok and Instagram
deliberately have none, because they are the two that work and the tests assert
they are unchanged.

Frames change **what counts as a trend**, never **what counts as evidence**.
The evergreen ban, the citation requirement and the specificity demand are
pinned by tests on every framed platform. Each frame that relaxes the macro
rule says so in its own prompt text.

Pinterest additionally gets a 45-day window and a month-long API search filter:
demand there builds rather than spikes — users plan, so autumn searches climb
from midsummer — and the tight window discarded the shape of the signal. The
one platform where looking back further is more accurate, not laxer.

**Search controls.** Recency, source deny-list and search depth are request
parameters (`search_recency_filter`, `search_domain_filter`,
`web_search_options`), not prose. The prompt text is kept anyway: a 4xx drops
the parameters and retries, so the prose is what survives that path, and
"avoid as PRIMARY evidence" is a judgment no domain filter can express. The
retry logs loudly, because a silent downgrade is how you come to believe a
filter is on when it never applied.

## The ingest function

`supabase/functions/ingest-trends/`. Deno. Not deployed by Vercel — needs
`supabase functions deploy ingest-trends`.

Pipeline: fetch → upsert → observe → lifecycle → tag → enrich.

Adapters implement `TrendSource`. `ensembledata.ts` is the original;
`http-source.ts` is configurable for pay-as-you-go providers via
`TREND_HTTP_URL` / `TREND_HTTP_TOKEN` / `TREND_HTTP_HEADER`. Shared post
parsing is in `tiktok-normalize.ts`, the seed hashtags in `hashtags.ts`.
Adapters run alongside each other and duplicates collapse keeping the richer
row, so a vendor cutover can overlap and be compared rather than switched
blind.

**Fail-soft, and the distinction that makes it honest.** An empty run writes
nothing and applies no lifecycle transitions, so one bad vendor day cannot
cascade every trend to `dead`. But "the vendor refused us" and "the vendor had
nothing" once produced identical output — a lapsed plan turned every call into
a skip, returned `[]`, and reported the run healthy with `ok: true, count: 0`.
Adapters now count 401/402/403/429 separately and throw when that is the whole
story, and `http-source` additionally distinguishes an unrecognized response
envelope from an empty week.

`?selftest=1` is unauthenticated by design — pure in-memory lifecycle
assertions, no data, no vendor, no spend. `?sourcetest=1` spends one call and
reports the actual response shape. `?enrichonly=1` drains the enrichment
backlog without spending the ingest budget.

## Monitoring

`api/cron/trend-health.js`, daily 13:00 UTC. Monitors the **age of the data**,
not the mechanism — that catches a dropped pg_cron schedule, a failed deploy, a
paused project, a rotated secret and an empty run identically, because they all
end the same way: `last_seen` stops moving.

Per-platform, not a global max: six platforms refreshing on schedule while a
seventh stops still produces a fresh-looking global maximum. Health is the
**oldest** platform.

Global rows only (`segment IS NULL`) on the research side. Counting both tiers
would let a healthy segment row make a platform look fresh while its global
refresh failed — the same shape as the bug this function already fixed once.

**Known gap:** per-segment research failures are not monitored. They degrade
gracefully to global rows so no creator sees an error, which is exactly the
disguise everything else in this file has worn at some point.
