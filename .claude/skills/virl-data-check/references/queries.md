# VIRL diagnostic queries

Ready-made SQL for the Supabase SQL editor. Each is phone-legible — few
columns, no horizontal scroll — because that is usually where they get read.

Every query here answers a question that was once answered by inference and
got the wrong answer.

## Contents

- [Is anything being written?](#is-anything-being-written)
- [Is a platform refusing, or just quiet?](#is-a-platform-refusing-or-just-quiet)
- [Did the per-segment research run?](#did-the-per-segment-research-run)
- [Is the research any good?](#is-the-research-any-good)
- [Is the observed pipeline alive?](#is-the-observed-pipeline-alive)
- [What is a creator actually being served?](#what-is-a-creator-actually-being-served)

---

## Is anything being written?

First question, always. Groups by platform AND tier, because a fresh
per-segment row can mask a failed global refresh, and the global row is the
one every creator falls back to.

```sql
select platform,
       coalesce(segment,'(global)') as tier,
       count(*) as rows,
       max(fetched_at)::date as newest,
       sum(jsonb_array_length(coalesce(items,'[]'::jsonb))) as items
from trends
where fetched_at >= now() - interval '10 weeks'
group by platform, coalesce(segment,'(global)')
order by platform, tier;
```

A platform missing entirely from these results has written nothing in ten
weeks — absence is the loudest result here, and the easiest to skim past.

## Is a platform refusing, or just quiet?

**The single most useful query in this file.** It distinguishes a platform that
searched and found little from one that searched and refused to answer — two
states with identical averages and completely different fixes.

```sql
select platform,
  count(*) as weeks,
  count(*) filter (where summary ~* '(quiet|no notable|no specific|nothing)') as quiet_weeks,
  round(avg(jsonb_array_length(coalesce(items,'[]'::jsonb))),1) as avg_items
from trends
where fetched_at >= now() - interval '10 weeks'
group by platform
order by quiet_weeks desc, platform;
```

Reading it:

- `quiet_weeks` near `weeks` → the platform is being asked a question that does
  not fit it. It is not broken; it is declining to answer, and the prompt is
  what needs to change.
- `quiet_weeks` at 0 with low `avg_items` → genuinely thin. Different problem.
- **`avg_items` on its own is a trap.** A platform returning a full batch one
  week in seven averages the same as one returning two items weekly. Only
  `quiet_weeks` separates them.

Then read the actual sentences — they usually name the cause outright:

```sql
select fetched_at::date as day, left(coalesce(summary,''),110) as summary
from trends
where platform = 'X'            -- ← the platform in question
  and fetched_at >= now() - interval '10 weeks'
order by fetched_at desc;
```

## Did the per-segment research run?

The weekly cron writes a global row per platform plus per-segment rows. Segment
failures degrade silently to global rows, so no creator sees an error — which
is exactly why this needs checking rather than waiting to be reported.

```sql
select coalesce(segment,'(global)') as tier,
       count(*) as rows,
       count(distinct platform) as platforms,
       max(fetched_at)::date as newest,
       sum(jsonb_array_length(coalesce(items,'[]'::jsonb))) as items
from trends
where fetched_at >= now() - interval '2 weeks'
group by coalesce(segment,'(global)')
order by tier;
```

Expect roughly 27 rows per week total: 7 global + 20 segment. Only 7 means the
segment tier did not run at all.

## Is the research any good?

Specificity — does the item name something a creator could go find? Note the
curly-quote class: research output uses typographic quotes, and a straight-only
`"` check silently misreports well-named items as generic. That mistake once
inflated this number by 15 points.

```sql
with items as (
  select t.platform, btrim(i->>'trend') as trend
  from trends t
  left join lateral jsonb_array_elements(coalesce(t.items,'[]'::jsonb)) i on true
  where t.fetched_at >= now() - interval '8 weeks'
)
select platform,
  count(*) filter (where trend is not null) as items,
  round(100.0*count(*) filter (where trend is not null
      and trend !~ '#[A-Za-z0-9_]{3,}'
      and trend !~ '[0-9]'
      and trend !~ '["""]')                      -- straight AND curly
    / nullif(count(*) filter (where trend is not null),0)) as generic_pct
from items group by platform order by platform;
```

Note the `left join lateral` — it keeps platforms with zero items in the output
as a `0` row instead of dropping them.

**Specificity is not relevance.** An item can be perfectly specific, dated and
cited while being about the wrong subject entirely — general platform culture
served to a real estate agent. This query cannot see that. For relevance, run
`npm run audit:trends`, which measures domain vocabulary, culture markers, and
how much per-segment research diverges from global research.

Repeat rate — is the research recycling itself?

```sql
with items as (
  select t.platform,
         to_char(date_trunc('week', t.fetched_at),'IYYY-"W"IW') as wk,
         regexp_replace(lower(btrim(i->>'trend')),'[^a-z0-9 ]','','g') as key
  from trends t
  left join lateral jsonb_array_elements(coalesce(t.items,'[]'::jsonb)) i on true
  where t.fetched_at >= now() - interval '8 weeks'
),
dupes as (
  select platform, key from items where key <> ''
  group by platform, key having count(distinct wk) > 1
)
select i.platform,
  round(100.0*count(*) filter (where d.key is not null)
    / nullif(count(*) filter (where i.key <> ''),0)) as repeat_pct
from items i left join dupes d on d.platform=i.platform and d.key=i.key
group by i.platform order by i.platform;
```

Exact-match only, so it understates. Treat it as a floor.

## Is the observed pipeline alive?

`trend_items` is written only by the `ingest-trends` edge function. It can be
completely dark while `trends` is full — that combination once ran for nine
days without anyone noticing.

```sql
select status,
       count(*) as items,
       max(last_seen)::date as newest,
       count(*) filter (where niche_scores is not null
                        and niche_scores <> '{}'::jsonb) as tagged,
       count(*) filter (where context is not null) as enriched
from trend_items
group by status
order by status;
```

`newest` more than ~5 days old means the ingest has stopped. Whether that is a
credentials problem or a genuinely empty week is answered by the function's run
summary, not here.

Is any single trend actually moving?

```sql
select ti.display_name, ti.status,
       count(o.*) as observations,
       min(o.observed_at)::date as first_seen,
       max(o.observed_at)::date as last_seen
from trend_items ti
join trend_observations o on o.trend_item_id = ti.id
where ti.status in ('rising','peaking')
group by ti.id, ti.display_name, ti.status
order by observations desc
limit 20;
```

A `rising` trend with one observation has no measured trajectory — its status
came from a single data point.

## What is a creator actually being served?

The end of the chain, and the only question that matters to a user. For a given
segment and platform, this is the row generation will read:

```sql
select platform, coalesce(segment,'(global)') as tier,
       fetched_at::date as day,
       jsonb_array_length(coalesce(items,'[]'::jsonb)) as items,
       left(coalesce(summary,''),90) as summary
from trends
where platform in ('TikTok','Instagram')        -- ← their platforms
  and (segment = 'real_estate' or segment is null)  -- ← their segment
  and fetched_at >= now() - interval '14 days'
order by (segment is null), fetched_at desc;
```

Segment rows sort first because that is the precedence the reader applies: a
segment row wins over a global row for the same platform even when older.
Outside the 14-day window both tiers are invisible to generation regardless of
what this returns.
