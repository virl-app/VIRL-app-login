# Handoff prompt — VIRL distribution plan

Paste the block below into a fresh thread when you're ready to work on distribution.
Written to be self-contained: it carries the numbers, so the new thread doesn't need
the audit conversation's context. Repo access helps but isn't required.

Companion docs already in the repo: `AUDIT.md` (product audit), `NEXT-STEPS.md`
(product execution sequence). This prompt deliberately does **not** re-open either.

---

```
I need a distribution plan for VIRL. This is a distribution and go-to-market
problem, not a product problem — a full product audit already exists in AUDIT.md
and an execution sequence in NEXT-STEPS.md in this repo. Please don't re-audit the
product or propose feature work; assume that track is handled.

## What VIRL is

A content strategist for solo personal brands. It generates a weekly short-form
social content plan — hooks, talking-head scripts, captions, carousels-as-text —
in the user's own voice. Repositioned around a sharper wedge: short-form social
for solo personal brands, delivered as a proactive weekly strategist, at a
solo-friendly price. The stated differentiator is voice fidelity: content that
sounds like the user, not like AI.

Primary audience hypothesis to date: real estate agents (Nashville / Williamson
County), plus small business owners and creators.

## The numbers (real, pulled from production)

- Project live since 2026-04-17. 29 lifetime signups — roughly 10/month.
- 19 of 29 saved a profile. 9 of 29 have ever generated a plan (31% activation).
- 6 monthly active users.
- COGS is ~$0.63/active user/month, so margin is not a constraint.
- Pricing today: Founder Circle (first 50) $20/mo for life or $215/yr;
  standard $25/mo or $249/yr. 14-day free trial.

## Why I'm asking for this

At ~10 signups/month, 31% activation, and (say) 25% trial-to-paid, that's
about 0.8 paying customers a month — roughly five years to fill 50 Founder
Circle spots. Fixing activation from 31% to 80% gets that to ~2/month, still
about two years. Taking signups from 10/month to 100/month and changing nothing
else gets to ~8/month. Every product fix multiplies a small number. The input
volume is the binding constraint.

A second reason: my 31% activation rate is currently uninterpretable, because
the 29 signups came from mixed sources. I can't tell whether the 69% who didn't
activate were blocked by friction or were never the right audience. A defined
acquisition channel is what makes that number readable.

## What already exists (built, but I need an honest read on whether it's working)

- Referral system: referral codes, milestone prompts at 3/7/15 plans generated.
  Note the milestone email was broken in production until recently, and a
  referral engine needs a base to refer from — 9 activated users isn't one.
- Founder Circle scarcity: 50 spots, $20/mo for life. This is a conversion
  mechanic applied to a funnel with no top; at 29 signups the scarcity isn't
  binding on anyone.
- Marketing skills in this workspace: virl-dm-prep (founder-led DMs to agents),
  virl-head-of-content (founder-led TikTok/Instagram), virl-campaign-launcher,
  virl-seo-strategist, virl-ai-seo, virl-brand-guidelines. Use these where they
  fit rather than inventing parallel approaches.

## One idea I want you to pressure-test, not just accept

VIRL's own product may be the test of its primary channel: use VIRL to generate
my founder-led TikTok/Instagram plan each week. If the account grows, that's
distribution and product-quality proof in the same loop. If VIRL can't move my
own account, that's a finding worth having early. Tell me honestly whether this
is leverage or a distraction — founder-led social is slow and I may be
rationalizing.

## Before you propose anything, ask me about

1. What I've already tried for distribution and how each attempt actually went.
2. How many hours a week I can genuinely commit to distribution work.
3. Whether real estate agents are a commitment or a starting hypothesis I'd drop.
4. Geographic scope — Nashville/Williamson County, or national.
5. Whether there's any paid budget, and how much.
6. Whether I have feedback from my marketing council yet, and what it said.

Don't guess at these. Ask, wait for my answers, then plan.

## What I want out of it

A distribution plan I can execute solo, containing:

- One ICP, defined tightly enough that it disqualifies people.
- ONE primary channel — not a portfolio — with a weekly hour budget, a
  cost-and-time-per-signup target, and explicit kill/scale thresholds so I
  know when to stop or double down.
- A 30/60/90 sequence of concrete actions, not principles.
- A recommendation on whether to park referrals until I have ~30 activated
  users, and on whether Founder Circle scarcity should be re-timed to when
  there's enough traffic for it to bind.
- The dogfooding loop assessed on its merits per above.
- Whatever measurement I need to tell a working channel from a dead one, given
  that most channels fail and I can only afford to run one at a time.

One open question I'd like your read on: an internal repositioning brief targets
a $29-49/mo price point, but what's actually shipped is $20 (Founder Circle) and
$25 (standard). I don't know whether that gap is deliberate or drift. Flag any
distribution implications either way, but don't turn this into a pricing project.

Be direct with me. If the plan is "do one unglamorous thing for twelve weeks,"
say that. I'd rather have one channel that works than five that might.
```
