-- Diagnostic queries from AUDIT.md §12.
-- Run these BEFORE starting any build brief — they determine which one is right.
-- Read-only. Paste into the Supabase SQL editor.

-- ─────────────────────────────────────────────────────────────────────────
-- Q1. IS THE VOICE ACTUALLY GOOD?
-- The whole differentiator. drift_score_after: 0 = identical to the
-- creator's reference corpus, 100 = maximally drifted. The retry gate
-- fires at 55 (chat.js:43).
--
-- Read: avg_drift under ~35 means voice fidelity is working. Over ~50
-- means the moat is not yet real and voice work outranks everything else.
-- ─────────────────────────────────────────────────────────────────────────
select
  date_trunc('week', created_at)::date            as week,
  generation_type,
  count(*)                                        as n,
  round(avg(drift_score_after)::numeric, 1)       as avg_drift,
  min(drift_score_after)                          as best,
  max(drift_score_after)                          as worst,
  count(*) filter (where drift_retried)           as retries
from usage_events
where drift_score_after is not null
group by 1, 2
order by 1, 2;

-- Q1b. When the corrective retry fires, does it actually help?
-- If after >= before, the retry is burning a full extra model call for nothing.
select
  count(*)                                        as retry_count,
  round(avg(drift_score_before)::numeric, 1)      as avg_before,
  round(avg(drift_score_after)::numeric, 1)       as avg_after,
  count(*) filter (where drift_score_after < drift_score_before) as improved,
  round(sum(drift_retry_cost_usd)::numeric, 4)    as retry_spend_usd
from usage_events
where drift_retried;

-- Q1c. How many users even have a voice reference to score against?
-- No sample_caption + no voice_samples + no research excerpts = drift is
-- never computed and voice fidelity is unmeasured for that user.
select
  count(*)                                                              as users,
  count(*) filter (where coalesce(sample_caption,'') <> '')             as has_sample_caption,
  count(*) filter (where coalesce(array_length(voice_samples,1),0) > 0) as has_voice_samples,
  count(*) filter (where coalesce(sample_caption,'') = ''
                     and coalesce(array_length(voice_samples,1),0) = 0) as no_voice_reference_at_all
from profiles;


-- ─────────────────────────────────────────────────────────────────────────
-- Q2. DOES ANYONE COME BACK?
-- One-and-done is the death signal for a weekly product. A week-one
-- funnel fix does nothing if week two never happens.
-- ─────────────────────────────────────────────────────────────────────────
select
  plans_generated,
  count(*) as users
from (
  select user_id, count(*) as plans_generated
  from usage_events
  where generation_type = 'plan'
  group by 1
) t
group by 1
order by 1;

-- Q2b. Per-user rhythm. days_between_first_and_last near 0 = one session.
select
  user_id,
  count(*) filter (where generation_type = 'plan')      as plans,
  count(*)                                              as all_gens,
  min(created_at)::date                                 as first_seen,
  max(created_at)::date                                 as last_seen,
  (max(created_at)::date - min(created_at)::date)       as days_span
from usage_events
group by 1
order by plans desc;

-- Q2c. DOES ANYONE ACTUALLY POST THE CONTENT?
--
-- IMPORTANT: do NOT read this off user_data.results. Results logging is a
-- manual, multi-step flow (SundayLogModal: remember → open → per-card
-- screenshot or type 3 numbers → verify → save, ×7 cards). A low number
-- there measures LOGGING FRICTION, not publishing. Using it as a publish
-- proxy was an error in an earlier draft of AUDIT.md §12.3.
--
-- Use `post_marked` instead: a one-tap toggle on each card
-- (index.html:4577), fired on toggle-on only. Far lower friction, so far
-- closer to a real publish signal.
select
  count(*)                                as post_marked_events,
  count(distinct user_id)                 as users_who_marked_posted,
  count(distinct properties->>'platform') as distinct_platforms
from events
where event_name = 'post_marked';

-- Q2b-i. Publish rate: marks-posted per plan generated, per user.
-- This is the number that says whether plans become posts.
select
  u.user_id,
  u.plans,
  coalesce(m.marked, 0)                                   as posts_marked,
  round(coalesce(m.marked,0)::numeric / nullif(u.plans,0), 1) as marked_per_plan
from (
  select user_id, count(*) as plans
  from usage_events where generation_type = 'plan' group by 1
) u
left join (
  select user_id, count(*) as marked
  from events where event_name = 'post_marked' group by 1
) m on m.user_id = u.user_id
order by u.plans desc;

-- Q2c-ii. Lighter-weight intent signals, for triangulation. Copying a
-- caption is the action immediately BEFORE posting — but note CopyBtn
-- (index.html:3064) currently fires no event, so `caption_copied` will
-- return zero until that is instrumented. See NEXT-STEPS.md Step 2.
select event_name, count(*) as n, count(distinct user_id) as users
from events
where event_name in ('post_marked','vault_saved','result_logged',
                     'plan_calendar_exported','caption_copied','card_copied')
group by 1 order by n desc;


-- ─────────────────────────────────────────────────────────────────────────
-- Q3. WHERE DOES THE FUNNEL LEAK?  (baseline for AUDIT.md F1)
-- Snapshot at time of audit: 29 signups → 19 named profile → 9 ever
-- generated a plan (31%). Re-run after any onboarding change.
-- ─────────────────────────────────────────────────────────────────────────
select
  (select count(*) from auth.users)                                        as signups,
  (select count(*) from profiles where coalesce(name,'') <> '')            as saved_a_profile,
  (select count(distinct user_id) from usage_events)                       as generated_anything,
  (select count(distinct user_id) from usage_events
     where generation_type = 'plan')                                       as generated_a_plan,
  (select count(distinct user_id) from usage_events
     where generation_type = 'plan'
     group by user_id having count(*) > 1 limit 1) is not null             as anyone_made_a_second_plan;

-- Q3b. Time from signup to first generation — the north-star constraint
-- is < 2 minutes. Anything in hours/days means they left and came back.
select
  u.id,
  u.created_at::date                                       as signed_up,
  min(e.created_at)::date                                  as first_gen,
  round(extract(epoch from (min(e.created_at) - u.created_at))/60) as minutes_to_first_gen
from auth.users u
join usage_events e on e.user_id = u.id
group by u.id, u.created_at
order by minutes_to_first_gen;
