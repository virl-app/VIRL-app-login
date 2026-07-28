# Email stance

The durable decisions about VIRL's email. This file is the constitution — it
changes rarely, and when it does, that's a decision worth a conversation.

**The one rule that keeps this file honest: nothing here describes behaviour
that isn't built.** Everything below is either a principle we hold or a
behaviour that ships today. Anything specified but unbuilt lives in
`decisions.md`, tagged NOT BUILT. This rule exists because its absence caused
real damage — the previous single-file guide specified frequency caps, quiet
hours, and a re-engagement flow in the same voice it used to describe shipped
behaviour, and for months nobody could tell which sentences were rules and
which were wishes. A chained re-engagement flow mailed dormant users monthly
and forever while the doc said "one attempt, then VIRL goes quiet." Both
looked authoritative. Only one was real.

Supersedes `docs/email-strategy-guide.md` (Jul 2026). The original is in git
history; nothing was deleted for being old, only for describing a product we
don't have.

## The thesis

Email is the only channel VIRL controls that lives in the user's daily
attention. The brand promise is **"VIRL doesn't waste your time."** Every email
must honour that or it doesn't get sent.

The bar is one sentence: *would a creator screenshot this email and send it to
a friend?* If no, don't send it.

Three consequences:

1. **Volume is the enemy.** Marketing cadence is once a month. Lifecycle email
   is trigger-based only — never "we miss you" nags, never broadcast for its
   own sake.
2. **Editorial beats promotional.** Changelogs read like a brief. Billing
   receipts read like notes from a person.
3. **Restraint compounds trust.** Send less, get opened more. Every send earns
   the next one; lose that attention and it doesn't come back.

## Voice

Every email is exactly one voice. A message never mixes them — a nudge that
opens as VIRL and closes as Lauren reads like two people wrote it, which is
worse than either alone. The classification lives in the header of
`api/_lib/email-templates.js`, and the sender address follows from it via
`FOUNDER_VOICE_TEMPLATES` in `api/_lib/email-send.js`. If the From line and the
signature disagree, one of the two is wrong.

- **One thought per email.** Two CTAs means two emails. Three sections means a
  newsletter, and we have exactly one of those.
- **Subject lines are sentences, not headlines.** No clickbait, no ALL CAPS, no
  emoji, no exclamation marks that aren't earned.
- **No urgency tropes.** No "ACT NOW," no countdowns. If something is genuinely
  time-bound, state it once, factually, and move on.
- **Sign-offs are humans.** Lauren's name on founder-voice mail, `VIRL` on
  transactional. Never "The VIRL Team."

## The lifecycle map

Every email belongs to exactly one stage.

| Stage | Window | Goal | Class |
|---|---|---|---|
| Consideration | pre-signup | get the address | marketing, opt-in |
| Activation | day 0–7 | first plan generated | transactional |
| Habit | day 7–30 | weekly rhythm | lifecycle, respects opt-out |
| Conversion | day 11–14 | trial → paid | transactional (billing-adjacent) |
| Retention / win-back | day 30+, lapsed | stay or come back | marketing, capped |

The marketing/transactional split is not editorial — it drives enforcement in
`api/_lib/email-send.js`. Marketing sends are skipped for opted-out users;
transactional sends are not. Classify at write time and the rest follows.

**Known gap:** there is no stage for *trial ended, still active, hasn't paid*.
Someone in that state receives one email on day 14 and then nothing, ever.
Tracked in `decisions.md`.

## Targeting: the two questions

Every targeting decision reduces to two axes — where someone is in the trial
(trialing → ending → ended → paid) and whether they're using the product
(active → quiet → gone). That's a grid, and most cells should be empty. Name
the cell before writing copy. If it's occupied, the honest move is usually to
replace the existing email rather than add a second one.

## What we don't do

- **"We miss you" emails.** If someone went quiet, they had a reason. One
  re-engagement attempt at 14 days inactive, then VIRL goes quiet.
- **Discount-led win-back.** No "20% off if you come back this week." The
  product is the offer; the price is the price.
- **Feature-of-the-week newsletters.** Changelog is quarterly at most, and only
  when something materially changes.
- **Seasonal urgency campaigns.** Not VIRL.
- **Cross-promotion of partners or affiliates**, on any VIRL email surface.
- **Re-confirmation campaigns** for people who unsubscribed. Once they're out,
  they're out.

## Cadence principles

Frequency caps and quiet hours are **specified but not enforced in code** — see
`decisions.md`. What follows is the intent, and it's what a reviewer should
hold a new email to even though nothing blocks a violation today.

- One marketing email per user per 7 days, four per month, across all
  campaigns.
- Each lifecycle email type fires at most once per type per user per week.
- No marketing or non-critical lifecycle sends between Saturday 6 PM and Monday
  8 AM local. Exceptions: trial-ending day-of, payment failures, security
  alerts, and the Sunday reset — Sunday evening is that email's premise rather
  than an accident of scheduling (ratified Jul 2026).
- Transactional has no cap. But the same transactional template firing more
  than three times in 24 hours to one user means a stuck trigger.

## Where the rest lives

| What | Where |
|---|---|
| What actually fires, for whom, today | `api/cron/email-triggers.js` — the code is the truth |
| Open decisions and unbuilt specs | `decisions.md` |
| Setup, env vars, debugging | `runbook.md` |
| Copy drafts not yet shipped | `copy-library.md` |
| Shipped copy | `api/_lib/email-templates.js` |
