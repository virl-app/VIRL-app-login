---
name: virl-data-check
description: Diagnose VIRL's data pipelines from the database rather than from inference — trend freshness, research quality, per-platform and per-segment coverage, silent failures. Use this skill whenever a question about VIRL touches whether something is WORKING, HEALTHY, BROKEN, STALE, EMPTY, or GOOD ENOUGH — "is the trend pipeline healthy", "did the weekly research run", "is the research any good", "why are creators seeing no trends", "did that fix work", "should we pay for X" — and any time you are about to characterize a pipeline's state in a sentence. Also use before recommending a vendor, a spend, or a rewrite whose justification rests on how well something is currently performing, and when a prior claim about pipeline health is being questioned or revisited.
---

# VIRL data check

VIRL's pipelines fail quietly. The recurring shape — documented in the
codebase's own comments and rediscovered several times since — is a failure
that renders **identically to a normal quiet week**: no error, no alert, a
healthy-looking 200, and a UI that shows its ordinary empty state. You cannot
reason your way to these. You have to look.

This skill exists because reasoning about them has a track record, and it is
bad. In one session an agent told the user three times that something was
healthy or scoped-correctly, and was wrong all three times. Each answer was one
query away from being right.

## The rule

**Any claim about the state of VIRL's data cites a query result.**

Not the code, not the schema, not what the pipeline is designed to do. The rows.

Applies to: is it working, is it healthy, is it good enough, did the fix land,
is this platform/segment/user affected, is X the only thing broken. If you are
writing a sentence that characterizes VIRL's data as being in some condition,
that sentence needs a result behind it.

When you cannot run the query — no credentials, an approval gate, a tool
failure — say so plainly and hand the user the SQL. "I can't confirm this from
here, run this and paste it back" is a complete and useful answer. A confident
guess dressed as a finding is not, and costs more to undo than the wait.

Being asked to double-check is not a prompt to re-argue the previous answer.
Re-run or re-derive it from data.

## Four ways VIRL data misleads, all observed

**Averages hide bimodality.** Five platforms averaged 1–4 research items a week
and read as "thin platforms". They were not thin. Facebook's twelve items all
arrived in one week and it produced nothing in the other six. The average
described a state the platform was never in. Count the *weeks that failed*, not
the mean of what was produced.

**The system explains itself in fields nobody reads.** The trend adapter logged
an HTTP 403 on every call and reported the run healthy. The research model wrote
"Quiet week for emerging MICRO-TRENDS on X" into `trends.summary` for seven
consecutive weeks — an exact diagnosis, stored in the database, unread. Before
theorizing about a silent failure, read the free-text column: `summary`,
`context`, the run's own log line. It has often already told you.

**A global maximum hides a lagging member.** `max(fetched_at)` across a
multi-platform or multi-tier table looks fresh while one member is weeks
behind. Group by the thing that can lag independently — platform, segment, tier
— and report the OLDEST, because a creator on the lagging member experiences
the lag in full no matter how current the others are.

**Rows that produce nothing disappear from grouped output.** A platform whose
every row has an empty `items` array contributes no rows to an item-level
GROUP BY and silently vanishes from the report meant to catch it. Aggregate
from the parent table, or LEFT JOIN, so a producer of nothing appears as a zero
rather than an absence.

## Working the question

Start from what the user would feel, not from the component you suspect. "A
creator on YouTube opens their plan and sees no trends" leads somewhere; "is
the ingest function OK" leads to a component that is often working fine while
the outcome is still broken.

Then, in order:

1. **Freshness** — is anything being written at all, and per group?
2. **Volume** — how much, and is it steady or bimodal?
3. **Self-report** — what do the free-text fields say about the empty runs?
4. **Quality** — of what exists, how much is usable?

Most investigations resolve at step 3.

Prefer one query that returns a small table over several that each return a
number: the user is often reading on a phone, and four columns that fit
without scrolling get read while twelve columns get truncated at exactly the
column that mattered.

## Query library

`references/queries.md` has the ready-made diagnostics, grouped by what you are
asking. Read it when you need a query rather than writing one from scratch —
several encode a correction that was learned the hard way, most obviously that
`quiet_weeks` and `avg_items` answer different questions and only one of them
is honest about a bimodal platform.

`references/schema.md` is the table and column map: what exists, which columns
carry the tier and the free-text self-report, and which joins are needed.

## Reporting what you find

Give the number and what it means for a creator, in that order. "X returned
zero items for seven straight weeks, so anyone posting on X has seen the empty
state every week since June" beats "X appears to have an issue."

Distinguish what you measured from what you inferred. If the numbers show a
platform is refusing and you have a theory about why, the theory is a theory
until its own query lands — label it that way, and name the query that would
settle it.

Where the finding contradicts something said earlier, including by you, state
the correction plainly and move on. The data is the authority; there is nothing
to defend.
