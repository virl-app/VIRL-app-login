---
name: virl-trend-dataflow
description: The map of VIRL's two trend pipelines — the observed `trend_items` ingest and the weekly `trends` research — covering which one feeds generation when, and which filters, fallbacks and freshness windows apply on each path. Use this skill before changing, debugging, or reasoning about anything touching trends, `trend-context.js`, `trends-refresh`, `ingest-trends`, the trend fallback, niche or segment scoring, trend freshness, or why a creator is or isn't seeing particular trends. Also use before asserting how trend data reaches a prompt, since the two paths differ in ways that are easy to state confidently and get wrong — and before changing a fallback, filter, or freshness constant, because several encode a decision whose reasoning is not obvious from the code.
---

# VIRL trend data flow

Two pipelines write trend data. They answer different questions, run on
different schedules, in different runtimes, and reach generation by different
paths with different filters. Most mistakes here come from carrying an
assumption from one path onto the other — including "TikTok is always included
as a fallback", which is true of one path and was false of the other for
months.

Read `references/paths.md` for the filter-by-filter detail. This file is the
shape.

## The two pipelines

**Observed** — `trend_items` + `trend_observations`. Written only by the
`ingest-trends` Supabase edge function (Deno), Mon + Thu 10:00 UTC via
`pg_cron`. Samples real posts through a vendor API, aggregates sounds across
hashtags, scores a lifecycle (`new`/`rising`/`peaking`/`fading`/`dead`) from
observation history, tags `niche_scores` with Claude, enriches context with
Perplexity.

This is the only source that can say something is **measurably** rising, and
the only one carrying real sound IDs.

**Research** — `trends`. Written by `api/cron/trends-refresh.js` (Node, Vercel),
Mondays 07:00 UTC. Asks Perplexity what is being discussed, per platform and
per segment. Auto-publishes with no review step.

This can say what is being **talked about**. It cannot say what is
accelerating — that number is not published anywhere for it to read. The
generation prompt is explicitly instructed never to call a research item
"peaking".

Neither is a fallback for the other in the sense of being interchangeable. They
answer different questions and degrade differently.

## Which one reaches the prompt

`buildTrendContext()` in `api/_lib/trend-context.js` is the single entry point.
Called from `api/chat.js` per generation.

```
observed rows exist and clear the fit floor
  → observed path, done
otherwise
  → research fallback
```

Observed always wins when present, because a measured rising sound beats a
publication's claim. The fallback fires only on an empty observed result — so
while the ingest is dark, **every** generation runs on research rows. That is
the state the system has been in, and it is why the research path deserves the
same scrutiny as the observed one despite being the "fallback".

Both paths fail open. Any missing table, empty result or Supabase blip returns
an empty block and the prompt builders use their explicit "no trends this week"
state. A trend outage must never break a generation — which also means a trend
outage is invisible from the UI, and is why the staleness monitor exists.

## Where the paths differ

This is the part that gets misremembered. Full detail in
`references/paths.md`; the differences that have actually caused bugs:

**Cross-platform fallback.** The observed path adds TikTok to the queried
platforms unconditionally — a trend peaking on TikTok is valid input for a
Reels target. The research path does **not** do this unconditionally: a
platform-wide TikTok row served to a YouTube creator is wrong about the
industry and the platform both, which is two layers of imprecision rather than
one. Only a *segment* row crosses platforms, because that one is already about
the creator's industry.

**Niche filtering.** Observed rows carry `niche_scores` and must clear
`FIT_FLOOR` (0.6). Research rows carry no scores at all — their niche relevance
comes from having been *researched* for that segment, which is why the
segment/global tier distinction matters so much on that path.

**Freshness.** Observed: 7 days. Research: 14 days. Different because they
refresh at different cadences, not by oversight.

**Lifecycle.** Observed rows have a status. Research rows have none and must
never be given one — `check-strategist` asserts this and will fail the build.

## Constants that encode a decision

Changing any of these changes behaviour in a way the number alone does not
convey. `references/paths.md` gives the reasoning for each.

| constant | value | file |
|---|---|---|
| `TREND_FRESHNESS_DAYS` | 7 | trend-context.js |
| `LEGACY_TREND_FRESHNESS_DAYS` | 14 | trend-context.js |
| `FIT_FLOOR` | 0.6 | trend-context.js |
| `MAX_TRENDS` | 5 | trend-context.js |
| `FALLBACK_PLATFORM` | `tiktok` | trend-context.js |
| `OBSERVED_STALE_DAYS` | 5 | cron/trend-health.js |
| `LEGACY_STALE_DAYS` | 10 | cron/trend-health.js |

The two staleness thresholds sit deliberately below the freshness windows they
guard, so the alert arrives with runway rather than after creators have already
gone dark.

## Before you change anything here

Run `npm run check` — `check:trends` and `check:strategist` between them assert
the tier precedence, the cross-platform rule, the off-limits filter in both
directions, the per-platform prompt frames, and the ban on inventing lifecycle
status. Several of these encode a correction; a test failing here is more often
a caught mistake than a stale test. Read the assertion's message and the
comment above it before concluding the test is wrong.

The off-limits filter **deletes** trends. A matching bug there produces an empty
trend block, which the fail-open design renders as an ordinary quiet week — so
its tests come in pairs, one proving the boundary is enforced and one proving
nothing else went with it. Preserve that pairing in anything you add.

For questions about what the data currently *says* rather than how it flows,
use `virl-data-check`.
