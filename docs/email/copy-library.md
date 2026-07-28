# Copy library

Drafts and approved copy. **This file is not a spec** — a draft living here
says nothing about whether the email exists. Every entry carries a status:

- **SHIPPED** — live. The authoritative copy is in `api/_lib/email-templates.js`;
  the version here is the draft it came from and may have drifted. Edit the code,
  not this file.
- **LOOPS** — code fires an event, the email itself lives in the Loops dashboard.
  Nothing here is authoritative and the repo can't tell you what actually sent.
- **NOT BUILT** — a draft only. Nothing sends this. Do not cite it as policy.
- **RETIRED** — deliberately removed. See `decisions.md` before reviving one.

New drafts belong here with a status, never in `stance.md`.

Recommended subject lines and body copy for every email VIRL should
send. Use these as starting points; iterate based on open rates.

### Account & auth (Resend / Supabase)

#### Welcome (signup) — `welcome` template

**Status: SHIPPED**
**System:** Loops (after migration) / Resend (currently)
**Fires:** new user signs up
**Personalization:** firstName

```
Subject: Welcome to VIRL

Hi {{firstName}},

You've got VIRL. Here's how to get the most from your first week:

1. Fill in your Creator Profile — 5 minutes, makes every plan sound like you
2. Generate your first VIRL Plan — full week's content in 60 seconds
3. Save what you post to the Vault — VIRL learns from what works

You have a 14-day free trial with 20 credits a week. After that, plans
start at $25/month (or $20/month if you grab one of the 50 Founder
Circle spots first).

If you get stuck, just reply. I read every email.

— Lauren
```

#### Password changed — `passwordChanged` template

**Status: SHIPPED**
**System:** Resend (security-critical)
**Fires:** any password change
**Personalization:** firstName

```
Subject: Your VIRL password was changed

{{firstName}}, the password on your VIRL account was just updated.

If this was you, no action needed.

If it wasn't you, reply to this email immediately so we can secure
your account.

For your reference, this notification is sent automatically every time
the password changes.
```

#### Account deleted — `accountDeleted` template

**Status: SHIPPED**
**System:** Resend
**Fires:** account deletion
**Personalization:** firstName

```
Subject: VIRL account closed

{{firstName}}, we've closed your VIRL account and deleted your data:

- Your auth record
- Your profile, vault, and saved plans
- Your weekly credits and trial state
- Your activity history

Your Stripe billing history (invoices, payment methods) is governed by
Stripe's retention policy and is outside our control.

If this wasn't you, reply immediately. Otherwise, thanks for trying VIRL.

— Lauren
```

### Billing (Resend mostly)

#### Subscription welcome — Founder Circle variant (Loops)

**Status: NOT BUILT (Loops owns the live send)**
**System:** Loops (event: `subscriptionStarted`, filter `foundingTier=founder_circle`)
**Personalization:** firstName, foundingPosition

```
Subject: Welcome to the Founder Circle

{{firstName}}, you're Founder #{{foundingPosition}}. One of the first 50.

Your pricing is locked at $20/month for as long as you stay with VIRL.
Forever. The Office Hours invitation is coming separately.

A few things included beyond the price:
- Direct line to me at hello@govirl.ai — that's a real direct line,
  not a support queue
- Monthly Founder Office Hours, live with me on Google Meet
- Beta access to new features 14 days before everyone else

I'll be in touch about our first Office Hours call (Friday, June 26 at
8 AM CT). In the meantime, you can find everything on the Founder
Circle tab inside the app.

— Lauren
```

#### Subscription welcome — Standard variant (Loops)

**Status: NOT BUILT (Loops owns the live send)**
**System:** Loops (event: `subscriptionStarted`, filter `foundingTier=standard`)
**Personalization:** firstName

```
Subject: Welcome to VIRL Standard

{{firstName}}, your VIRL subscription is active. 150 credits a week,
every week — enough for a full content plan, captions, scripts, and
scans, with room to spare.

A few starting tips:
- Update your Creator Profile if you haven't — it sharpens every plan
- Save what you post to the Vault so VIRL learns what works
- The Sunday Log lets you log results in 30 seconds

If you ever need anything, reply to this email.

— Lauren
```

#### Payment failed — `paymentFailed` template

**Status: SHIPPED**
**System:** Resend (action required)
**Personalization:** firstName

```
Subject: Payment couldn't be processed

{{firstName}}, your VIRL payment didn't go through. Your subscription
is still active for now — Stripe will retry over the next few days.

If you'd like to update your card immediately, you can do that from
the Manage Subscription button in your VIRL profile.

If you have questions, just reply.

— Lauren
```

#### Renewal upcoming — `renewalUpcoming` template

**Status: SHIPPED**
**System:** Resend
**Personalization:** firstName, amount, renewalDate

```
Subject: Your VIRL renewal is coming up

{{firstName}}, heads up — your VIRL subscription renews
{{renewalDate}} for {{amount}}.

Nothing to do unless you'd like to update your card or change plans —
both are in the Manage Subscription section of your profile.

— Lauren
```

#### Subscription cancelled — `subscriptionCancelled` template

**Status: SHIPPED**
**System:** Resend (receipt)
**Personalization:** firstName

```
Subject: Your VIRL subscription is cancelled

{{firstName}}, your VIRL subscription is cancelled. You'll continue to
have access until the end of your current billing period.

After that, your account stays — your saved content, vault, and
profile — but you'll go back to the free trial state. You can
resubscribe anytime from inside the app.

If you have a minute, I'd love to know what prompted this. Reply with
a sentence or two — it shapes what I build next.

— Lauren
```

### Founder Circle (Loops)

#### Founder Circle is full — campaign

**Status: LOOPS — event fires, email lives in the dashboard**
**System:** Loops campaign (manually triggered when `foundingCircleFull` event fires)
**Audience:** waitlist + all Standard customers

```
Subject: The Founder Circle is full

The Founder Circle filled in [X days]. Thank you to the 50 people who
believed in VIRL first.

Standard pricing now applies for everyone — $25/month or $249/year.
The Founder Circle is closed for good. There won't be another.

If you've been waiting, this is your sign to try VIRL free for 14 days.
No credit card required.

— Lauren
```

#### Office Hours invite (Loops automation)

**Status: NOT BUILT**
**System:** Loops (triggered by `subscriptionStarted` + `foundingTier=founder_circle`)
**Personalization:** firstName, nextOfficeHoursDate (manual)

```
Subject: Your first Founder Office Hours

{{firstName}}, here's how Founder Office Hours work:

- Last Friday of every month, 8 AM CT
- 45 minutes on Google Meet — brief update from me, then open Q&A
- Recorded for anyone who can't make it live
- First call: Friday, June 26

Google Meet link: [paste your stable Google Meet link here]

Add to your calendar: [calendar link if you have one]

See you there.

— Lauren
```

#### Office Hours monthly reminder

**Status: NOT BUILT**
**System:** Loops scheduled (a few days before each last Friday)
**Audience:** Founder Circle segment

```
Subject: Founder Office Hours this Friday at 8 AM CT

Quick reminder — Founder Office Hours is this Friday, [Date], at
8 AM CT. Google Meet link: [link]

Bring whatever's on your mind — content questions, growth stuff,
product feedback. Open agenda.

If you can't make it, it'll be recorded and posted on the Founder
Circle tab within 24 hours.

— Lauren
```

#### Office Hours post-call summary

**Status: NOT BUILT**
**System:** Loops manual send (after each call)
**Audience:** Founder Circle segment

```
Subject: Recap from Founder Office Hours — [Month]

Thanks to everyone who joined Office Hours this month. Quick recap:

1. [Topic 1]: [3-5 word summary]
2. [Topic 2]: [3-5 word summary]
3. [Question that came up multiple times]: [your take]

Recording is on your Founder Circle tab.

Next call: [date], 8 AM CT.

See you then.

— Lauren
```

#### Beta feature announcement (future)

**Status: NOT BUILT**
**System:** Loops manual send (when a beta ships)
**Audience:** Founder Circle segment

```
Subject: Founder Circle beta — [Feature name]

{{firstName}}, you have early access to [Feature name] starting today.

What it does: [1-2 sentence description]

How to find it: [where in the app]

It rolls out to all paid users in 14 days. Your feedback shapes what
ships — reply with what works, what doesn't.

— Lauren
```

### Trial & onboarding (currently Resend, migrate to Loops)

Existing copy is in `api/_lib/email-templates.js`. Suggested improvements
when migrating to Loops:

#### Trial day 7

**Status: SHIPPED**
**Tone:** noticing not nagging. Highlight what they've done.

```
Subject: A week in, {{firstName}}

You've been on VIRL for a week. Quick check-in: [if they've generated
plans, celebrate; if not, gentle nudge].

You've got 7 days left in your trial. After that, VIRL is $25/month —
or $20/month if a Founder Circle spot is still open
([X] of 50 left as of today).

If you've been waiting to test something, this is the week.

— Lauren
```

#### Trial day 11

**Status: SHIPPED**
**Tone:** clear about what's ending.

```
Subject: 3 days left, {{firstName}}

Heads up — your free trial ends in 3 days.

If VIRL has earned a place in your routine, lock it in. If it hasn't,
no hard feelings, the trial just ends and your account stays in
free-tier state.

[Founder Circle CTA if available, else Standard CTA]

— Lauren
```

#### Trial day 13

**Status: SHIPPED**
**Tone:** last chance, not pushy.

```
Subject: Trial ends tomorrow

{{firstName}}, your trial ends tomorrow. After that, you'll keep your
account but lose the weekly credit allowance.

If you want to continue, [CTA]. If now's not the right time, no problem
— resubscribe anytime later.

— Lauren
```

#### Trial expired

**Status: SHIPPED**
**Tone:** door's still open.

```
Subject: Your trial ended

{{firstName}}, your VIRL trial ended. Your account is still here —
your profile, your vault, your plan history.

When you're ready, [CTA]. Until then, nothing changes.

— Lauren
```

### Engagement (Loops over time)

#### Weekly reset

**Status: SHIPPED**
**System:** Loops (trigger weekly on the user's reset day)
**Personalization:** firstName

```
Subject: Fresh credits this week

{{firstName}}, your 150 credits just refilled. Enough for a full plan,
captions, scripts, and scans — every week.

What's on the agenda this week?

— Lauren
```

#### Phase 1 no plan (24h after signup, hasn't generated)

**Status: SHIPPED**

```
Subject: Want a hand with your first plan, {{firstName}}?

It's been a day since you joined VIRL but you haven't generated your
first plan yet. Two-thirds of users who don't generate within 48 hours
never come back, so let me make this easy:

[Generate my first plan →]

Takes 60 seconds. If you get stuck, reply and tell me where.

— Lauren
```

#### Inactive 7d

**Status: RETIRED Jul 2026 — replaced by the single-shot re-engagement**

```
Subject: Quick check-in

{{firstName}}, haven't seen you in VIRL for a week. Hope things are
going well.

If something stopped working or didn't click, I'd love to know.
Reply with a sentence — even "too busy" is useful intel.

If you're back at it, [generate a fresh plan →]

— Lauren
```

#### Inactive 30d

**Status: RETIRED Jul 2026 — replaced by the single-shot re-engagement**

```
Subject: It's been a month

{{firstName}}, it's been 30 days since you used VIRL. I'm not going to
bug you — but if something specific drove you away, I'd love to hear
about it.

Reply with one line, or just ignore this and I'll get the message.

— Lauren
```

#### Sunday log nudge

**Status: RETIRED — folded into the Sunday reset**

```
Subject: Sunday log — 30 seconds

{{firstName}}, you've got {{unloggedCount}} unlogged posts from this
week. VIRL learns from what you logged — better data, better plans.

[Log it now →]

Takes about 30 seconds.

— Lauren
```

#### First plan generated

**Status: SHIPPED**

```
Subject: Your first plan is in the books

{{firstName}}, you generated your first VIRL plan. That's the hardest
part.

Now: pick a card you like, edit if you want, hit Post when you're
ready, and log the result in the Vault. VIRL learns from what worked.

Catch you next week.

— Lauren
```

#### 30-day milestone

**Status: LOOPS — event fires, email lives in the dashboard**
**System:** Loops (already, event: `thirtyDayMilestone`)

```
Subject: You've been on VIRL a month

{{firstName}}, you've been with VIRL for 30 days. Real consistency.

If VIRL has earned its place, no need to do anything — keep going.

If you have feedback (what's missing, what could be sharper), hit
reply. I read every one.

— Lauren
```

#### Referral milestone (3 / 7 / 15 plans)

**Status: SHIPPED**

```
Subject: {{milestone}} plans deep

{{firstName}}, you've generated {{milestone}} plans in VIRL. That's
real momentum.

If a creator-friend would benefit, send them: [referral link]
They get the trial; you get [reward, if applicable].

Either way — keep going.

— Lauren
```

### Admin (Resend)

#### Playbook drafts ready

**Status: SHIPPED**

```
Subject: VIRL playbook drafts ready for review ({{count}})

{{count}} new platform-playbook drafts are waiting in the Admin tab.

[Summaries]

Review and approve in the Admin dashboard.
```

### Lifecycle marketing — opt-in required (Loops campaigns)

These are the only emails that fire `marketing: true` and respect the
suppression list at `api/_lib/email-send.js` (or the equivalent
contact-subscribed check in Loops once the sync gap from §9 is closed).

#### Re-engagement — single-shot, day 14 inactive (NEW)

**Status: SHIPPED Jul 2026 as reengagement_14d**

**System:** Loops automation
**Fires:** 14 calendar days with zero `plan_generated`, `caption_generated`,
or `scan_*` events
**Suppression:** marketing (respects opt-out); fires AT MOST ONCE per user
ever via a `reengagement_sent_at` contact property
**Replaces:** the existing chained `inactive_7d` + `inactive_30d` cadence —
see §10 for the cadence rationale

```
Subject: did the strategy go quiet, or just the inbox?
Preheader: A 60-second check-in from VIRL.

{{firstName}}, it's been two weeks since you generated a plan.

If something fell off — life, the algorithm, the week from hell — no
judgment. The account is still here, your voice is still saved, and a
new week is one tap away:

[Open VIRL →]

If VIRL just isn't the right fit, that's useful information for me. I
read every reply.

— Lauren

PS: This is the only nudge you'll get from me. After this, the inbox
is yours.
```

**Setup steps (Loops):**
1. Build the email in Loops's visual editor under **Transactional**
   templates → name it `reengagement_14d`.
2. Create an **Audience filter** in Loops: `lastActiveAt >= 14 days ago`
   AND `lastActiveAt < 21 days ago` AND `reengagement_sent_at is empty`
   AND `marketingSubscribed = true`.
3. Create an **Automation** triggered on a daily cron event (use the
   existing `api/cron/email-triggers.js` to fire a Loops event named
   `cron_daily_check`). The Loop sends the email to any contact
   matching the audience filter, then sets `reengagement_sent_at` on
   the contact so it can't fire again.
4. Set Loops's **Audience filter** to also exclude `unsubscribed = true`
   contacts (this is a Loops-managed flag; one-click unsub sets it).
5. Test by manually setting `lastActiveAt` to 15 days ago on a test
   contact and running the cron via `vercel dev` → `curl localhost:3000/api/cron/email-triggers`.

#### Monthly editorial from VIRL (NEW)

**Status: NOT BUILT**

**System:** Loops campaign (broadcast to opted-in segment)
**Fires:** First Tuesday of each month, 9:00 AM CT
**Suppression:** marketing (opt-in only); never sends to free-trial-expired
users who never paid

```
Subject: VIRL monthly — what's working in {{month}}
Preheader: Three observations from a quiet month watching the feed.

Hi {{firstName}},

Three things I noticed across the creator economy this month:

1. {{observation_1_headline}}
   {{observation_1_one_line}}

2. {{observation_2_headline}}
   {{observation_2_one_line}}

3. {{observation_3_headline}}
   {{observation_3_one_line}}

One thing worth trying this month:

{{practical_takeaway_2_to_3_sentences_max}}

That's it. See you in {{next_month}}.

— Lauren

---

Got VIRL in {{signup_month}}. {{user_plan_count}} plans generated since.
You can [unsubscribe from the monthly]({{unsub_url}}) any time —
transactional emails will keep coming.

VIRL, [physical address]
```

**Setup steps (Loops):**
1. Create a **Campaign** in Loops named `monthly_editorial_{{YYYY_MM}}`.
2. Audience: `marketingSubscribed = true` AND `unsubscribed = false`
   AND (`plan = founding` OR `plan = standard` OR `plan = pro` OR
   `(plan = free AND trialDaysRemaining > 0)`).
3. Write the issue 5 business days before send. **Write ahead** — last-
   minute monthly editorials destroy the quality bar.
4. Send a test to yourself + one peer reviewer. Walk away. Re-read in
   the morning before scheduling.
5. Schedule for first Tuesday at 9:00 AM CT.
6. After send, log open rate, click rate, unsubscribe rate, and one
   qualitative note in the monthly retro doc.

**Three-issue runway rule:** Always have the next three issues drafted
or outlined. If the runway drops to zero, skip the month entirely —
don't ship a weak issue to hit a cadence.

#### Meaningful changelog (NEW)

**Status: NOT BUILT**

**System:** Loops campaign (broadcast)
**Fires:** When something materially changes the product. Target cadence
is once per quarter, never more than once per month.
**Suppression:** marketing (opt-in only)

```
Subject: VIRL changed in three ways this quarter
Preheader: New: {{shortest_marquee_change}}.

{{firstName}}, three changes worth knowing about:

**{{change_1_title}}**
{{change_1_two_sentences_max}}

**{{change_2_title}}**
{{change_2_two_sentences_max}}

**{{change_3_title}}**
{{change_3_two_sentences_max}}

If you want to try them, just open VIRL — nothing to enable.

— Lauren
```

**Setup steps (Loops):**
1. Create a **Campaign** in Loops named `changelog_{{YYYY_QN}}`.
2. Audience: same as the monthly editorial — opted-in, on a valid plan.
3. Cap the email at exactly three changes. If you have more, save them
   for the next quarter. The discipline keeps the email scannable and
   keeps the changelog from devolving into release-note spam.
4. Each change is **two sentences maximum**. What it is, and what it
   unlocks for the user. Skip the engineering details.
5. Send Tuesday-Thursday, 10:00 AM CT. Avoid Monday morning (inbox
   overload) and Friday afternoon (low open rates).

---
