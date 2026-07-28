# Email decisions

Everything specified-but-unbuilt, every open question, and every settled
decision worth not relitigating.

The point of separating this from `stance.md` is that the previous single-file
guide mixed the two, and unbuilt specs read as shipped policy. **If an item
here is NOT BUILT, no part of the system behaves this way today.**

Status values: `NOT BUILT` · `OPEN` · `SETTLED` · `DONE`

---

## NOT BUILT — specified, nothing enforces it

### Frequency caps and quiet hours

`api/_lib/email-send.js` checks marketing opt-out and **nothing else**. No
frequency cap, no monthly ceiling, no quiet hours, no per-type throttle. The
intent is recorded in `stance.md`; the enforcement doesn't exist.

This is the highest-leverage unbuilt item. A single cap in `sendEmail()` — one
marketing email per user per 7 days — is roughly fifteen lines and would make
every future email safe by default, because you'd stop having to reason about
how independent triggers interact. It also fixes two live collisions on its
own (below).

### Two same-day collisions

Both are live, both are the kind of thing a cap would absorb:

- **Day 7.** `trial_day_7` and `weekly_reset` fire in the same run. Not
  coincidence: `handle_new_user` seeds `credits.reset_at` to signup + 7 days,
  and a user who never generates never re-anchors it, so both gates turn true
  at the same instant. Two emails both framed as "a new week starts."
- **Day 14.** `trial_expired` and `reengagement_14d` fire in the same run for
  anyone whose last activity was signup. One says the trial ended, the other
  asks where they went. This also spends the once-ever re-engagement send on
  the noisiest possible day.

The lifecycle pass has no same-day guard. The evening reminder pass already has
exactly one (`userGotOtherEmailToday`) — the fix is largely moving it.

### The `ended + active` gap

No email reaches an engaged, unconverted user after day 14. They get
`trial_expired` once and then nothing, permanently — too active to qualify for
re-engagement, past every other trigger. Options raised: a day-21 upgrade
nudge, or an upgrade-framed Sunday reset variant. Both need copy and a call on
whether the lifecycle map gains a stage between Conversion and Retention.

---

## OPEN — needs a decision

### Which system owns triggered email

`EMAIL_VIA_LOOPS` moves the entire trial sequence between Resend and Loops
without a code change, so "what does this user get?" cannot be answered from
the repo alone. Running both is the worst state.

The case for consolidating on Resend: the hard part of this system is the
*conditions*, and conditions in a dashboard can't be read, diffed, reviewed, or
tested. Every defect found to date has been a condition bug. Copy iteration is
what Loops buys, and for ~10 emails that's a weak trade.

The case for Loops: a visual editor matters if someone who doesn't deploy code
will write email copy.

Deliberately left undecided (Jul 2026) so the docs restructure could proceed.
Cost of consolidating: porting `creditsLow`, `creditsExhausted`, and
`thirtyDayMilestone`, then deleting `api/_lib/loops.js` and the flag.

### The marketing opt-out default

The signup checkbox defaults to **unchecked** (`index.html`, `useState(false)`,
commented as a GDPR-safe default), and signup writes
`email_preferences.marketing_opt_out = !marketingOptIn`. So six of ten
lifecycle emails — `trial_day_7`, `weekly_reset`, `phase1_no_plan_24h`,
`sunday_reset`, `posting_reminder`, `reengagement_14d` — never reach a default
signup. A default user gets four: `welcome`, `trial_day_11`, `trial_day_13`,
`trial_expired`, with a ten-day silence between day 0 and day 11.

That may be exactly right for compliance. What's *not* intentional is the
inconsistency below (audit gap 3): accounts with no `email_preferences` row at
all default to opted **in**, so older accounts receive everything. That split
is why test accounts were receiving Sunday resets that newer real users may
never have seen.

**Nobody has measured the ratio.** Before investing in lifecycle email, run:

```sql
select
  count(*) filter (where p.marketing_opt_out is not true) as can_receive_marketing,
  count(*) filter (where p.marketing_opt_out is true)     as opted_out,
  count(*) filter (where p.user_id is null)               as no_row_defaults_opted_in,
  count(*)                                                as total
from auth.users u
left join email_preferences p on p.user_id = u.id;
```

If most users are opted out, fixing trigger bugs is polishing a machine that
isn't running, and the opt-in flow is the real priority.

### Simplification proposal

Not executed. Collapse the trial sequence from four emails to two (day 12
"ends in 2 days", day 14 "it ended"), drop `weekly_reset` in favour of
`sunday_reset`, add the day-21 upgrade nudge, and replace the hand-written
`if` blocks in the cron with a declarative trigger table so the whole system
reads on one screen. Target: nine lifecycle emails, only two recurring.

### June 2026 opt-in audit — three gaps still open

| # | Gap | Impact |
|---|---|---|
| 1 | `email_preferences` schema not in `/migrations` | schema drift, environments can't be reproduced |
| 2 | `user_metadata.marketing_opt_in` written but never read | a second, stale signal that can diverge from the source of truth |
| 3 | Missing `email_preferences` row defaults to opted **in** | GDPR-questionable; the inconsistency described above |
| 4 | Loops contact sync omits opt-in state | any Loops marketing send bypasses the Supabase suppression list entirely |

Gap 4 is a live compliance exposure for as long as Loops sends anything
marketing-classified. The fix is to thread `marketingSubscribed` through
`updateLoopsContact`, call it on signup and on unsubscribe, backfill once, and
make every Loops audience filter require it.

---

## SETTLED — don't relitigate without new information

**Sunday reset is exempt from quiet hours** (Jul 2026). It sits inside the
documented Saturday 6 PM – Monday 8 AM window, but Sunday evening is the
email's premise, not a scheduling accident. The rule stands for everything
else.

**Retire the chained re-engagement flow; ship the single shot** (Jul 2026).
Chosen over keeping the chain with upgrade-framed copy, and over a temporary
suppression guard. `reengagement_14d` fires once per user ever, in a 14–21 day
window. The 21-day ceiling means deploying it didn't blast every dormant
account, and accounts past 21 days idle go quiet — the intended end state.

**Comped testers are never suppressed as expired.** `api/chat.js` bypasses the
trial day cap while a comp is live, so they genuinely can generate; silencing
their mail would withhold email about actions the app permits. When a test
account is unexpectedly receiving mail, check `comp_expires_at` before assuming
a bug.

**One-shot sends fail toward silence; recurring sends fail open.** A
once-ever email spent wrongly can't be recovered, so unreadable data means
don't send. A recurring email comes round next week, so a transient blip
shouldn't kill it.

---

## DONE

**Single-shot re-engagement shipped** (Jul 2026) — `reengagement_14d`, built on
Resend rather than the Loops automation originally sketched. The cron already
walks every user daily and one-shot-ever is enforced free by the `email_sends`
unique index, so a Loops audience filter would have added a second system
without adding a guarantee. Both retired templates deleted, not left dormant.

**Sunday reset trial gating** (Jul 2026) — the evening pass had no trial check
at all, which mailed expired accounts the build-your-week pitch weekly and
forever. Guard is "expired AND no live plan," not a blanket expiry skip.

**Failed credits reads no longer misclassify payers** (Jul 2026) —
`fetchCredits` conflated a failed read with an absent row, making a paying
customer look like an expired free trial and firing the whole trial sequence at
them. It now throws; the per-user catch skips them for the day.

---

## Known defects, not yet fixed

- **`past_due` and `cancelled` aren't in `PAID_PLANS`.** A paying member whose
  card fails once is reclassified as a free trial: sent the trial sequence
  *and* 402'd out of generating, shown the upgrade wall. The list is duplicated
  in `api/cron/email-triggers.js`, `api/chat.js`, and `index.html`. Customer-
  facing; highest priority.
- **`thirtyDayMilestone` measures from signup, not subscription.** Someone who
  subscribes on day 20 is thanked for 30 days of membership after 10.
  `credits.subscription_started_at` already exists and isn't fetched.
- **`phase1_no_plan_24h` fires on a false premise.** It gates on
  `profiles.name`, which signup auto-seeds, so "Your profile's set" reaches
  people who never opened the profile screen.
- **Old free accounts receive all four trial emails at once.** The gates are
  `>=`, all simultaneously true past day 14. Deduped, so once — but that once
  is four contradictory emails in one run. The `>=` bounds are deliberate (they
  self-heal a missed cron day), so tightening to windows trades that away.
