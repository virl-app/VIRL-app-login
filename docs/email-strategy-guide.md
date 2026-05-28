# VIRL — Email Strategy & Operations Guide

End-to-end reference for VIRL's email infrastructure. Covers the
strategic split between Resend and Loops, the practical steps for
managing each, and recommended content for every email VIRL sends.

This is a living doc — when you change the email system, update this.

---

## Table of contents

1. [Strategy: Resend vs Loops](#1-strategy-resend-vs-loops)
2. [Resend — setup, sending, managing](#2-resend--setup-sending-managing)
3. [Loops — setup, automations, campaigns](#3-loops--setup-automations-campaigns)
4. [Supabase Auth emails (separate system)](#4-supabase-auth-emails-separate-system)
5. [Email content library](#5-email-content-library)
6. [Migration plan: Resend → Loops over time](#6-migration-plan-resend--loops-over-time)
7. [Quick reference](#7-quick-reference)

---

## 1. Strategy: Resend vs Loops

### The principle

**Resend = transactional.** Emails that *must* arrive, immediately, no
marketing fluff. Password resets, payment failures, account confirmations.
Missing them causes a customer problem.

**Loops = lifecycle / marketing.** Emails that drive engagement, retention,
conversion. Welcome sequences, trial nudges, milestones, campaigns. Missing
them is a missed opportunity, not a broken flow.

### The decision test

*"If this email never arrives, is the customer blocked or just slightly
less engaged?"*

- Blocked → **Resend**
- Less engaged → **Loops**

### Why two systems?

**Resend pros:** direct API control, predictable delivery, low cost per
send, excellent transactional deliverability, version-controlled
templates in code.

**Resend cons:** copy changes require code deploys, no visual editor,
no built-in automation/sequences, no segmentation.

**Loops pros:** visual editor, drag-and-drop automations, segmentation
by contact properties, A/B testing, campaigns/broadcasts, copy iteration
without deploys.

**Loops cons:** higher cost per send, queued delivery (less predictable
timing), dependent on Loops uptime, more setup overhead.

### VIRL's split

| Email | System | Why |
|---|---|---|
| Password changed confirmation | Resend | Security-critical |
| Payment failed | Resend | Action required |
| Renewal upcoming | Resend | Action required |
| Account deleted | Resend | Receipt of irreversible action |
| Subscription cancelled (receipt) | Resend | Receipt of state change |
| Welcome (signup) | **Loops** (after migration) | Marketing-tone, iterate copy |
| Welcome (post-subscription) | **Loops** | Tier-aware variants |
| Payment confirmation | **Loops** | Tier-aware, marketing-tone |
| Trial day 7 / 11 / 13 / expired | **Loops** (migrate) | Pure marketing, iterate constantly |
| Inactive 7d / 30d | **Loops** (migrate) | Re-engagement campaigns |
| Weekly reset | **Loops** (migrate) | Engagement |
| Sunday log nudge | **Loops** (migrate) | Engagement |
| First plan generated | **Loops** (migrate) | Milestone celebration |
| 30-day milestone | **Loops** (already) | Milestone celebration |
| Referral milestone | **Loops** (migrate) | Celebration |
| Founder Circle welcome (FC variant) | **Loops** | Tier-aware |
| Founder Circle payment confirm (FC variant) | **Loops** | Tier-aware |
| Founder Circle is full | **Loops campaign** | Broadcast to segment |
| Office Hours invite | **Loops** | Automation |
| Office Hours monthly reminder | **Loops** | Scheduled automation |
| Office Hours post-call summary | **Loops** | Manual send to segment |
| Beta announcement | **Loops** | Manual send to segment |
| Playbook drafts ready (admin) | Resend | Internal alert |

---

## 2. Resend — setup, sending, managing

### What Resend does for VIRL

Sends transactional + (currently) most lifecycle emails directly from the
app code. Idempotency is handled via the `email_sends` table — every send
is keyed by `(user_id, template, dedupe_key)` so retries and concurrent
sends collapse cleanly.

### Required env vars

| Variable | Purpose | Where set |
|---|---|---|
| `RESEND_API_KEY` | Resend API authentication | Vercel → Production |
| `EMAIL_FROM` | Default From address (e.g. `VIRL <hello@govirl.ai>`) | Vercel → Production |
| `SUPABASE_URL` | For the `email_sends` dedup table | Already set |
| `SUPABASE_SERVICE_KEY` | For the `email_sends` dedup table | Already set |

If `RESEND_API_KEY` is missing, every email-send call silently no-ops
(see `api/_lib/email-send.js` line 17: `emailEnabled()` gate). The app
never crashes from a missing key.

### Domain setup (one-time)

Already done if `hello@govirl.ai` is currently sending. If you ever switch
domains:

1. Resend Dashboard → Domains → Add domain
2. Add the DNS records (SPF, DKIM, DMARC) to govirl.ai
3. Wait for verification (~minutes)
4. Update `EMAIL_FROM` env var in Vercel

### How email sending works (architecture)

All sends go through `sendEmail()` in `api/_lib/email-send.js`:

```js
import { sendEmail } from "./_lib/email-send.js";
import { welcome } from "./_lib/email-templates.js";

const tpl = welcome({ name });
await sendEmail({
  userId:    user.id,
  to:        user.email,
  template:  "welcome",         // matches the function name; used as dedup key part
  dedupeKey: "welcome",         // unique per (user, intent)
  subject:   tpl.subject,
  html:      tpl.html,
  text:      tpl.text,
  marketing: false,             // true = adds List-Unsubscribe header
});
```

The function:
1. Calls `claimSend()` — inserts into `email_sends`. If the row exists
   (duplicate), aborts.
2. POSTs to Resend's API with the rendered HTML + text.
3. Records the returned Resend message ID back into `email_sends`.

**Dedup keys:** use a stable key for one-off emails (e.g. `"welcome"`,
`"trial_day_7"`). Use a time-windowed key for recurring nudges
(e.g. `"weekly_reset_2026-W22"` so it fires once per week). For events
that can recur per object, key by the object id
(e.g. `"renewal_" + invoiceId`).

### How to add a NEW Resend template

Three steps:

#### Step 1: Add the template function

In `api/_lib/email-templates.js`, add a function near the others:

```js
export function myNewEmail({ name }) {
  const headline = "Your subject-line vibes headline";
  const body = `
    <p style="margin:0 0 12px">${name ? name + "," : "Hi,"} the situational
    body copy goes here. Keep paragraphs tight.</p>
    <p style="margin:0 0 16px">Second paragraph if needed.</p>
    <p style="margin:0">Sign-off line. — Lauren</p>`;
  return {
    subject: "Email subject line",
    html:    layout({ eyebrow: "Category Label", headline, body }),
    text:    `${headline}\n\nPlain-text version of the body for clients that strip HTML.\n\nSign-off line. — Lauren`,
  };
}
```

The `layout()` helper wraps your `headline` + `body` in the VIRL email
shell (navy header, footer, unsubscribe link). All templates use it.

#### Step 2: Call it from the right place

Pick where in the app the email should fire. Examples:
- On signup: `api/email/welcome.js` (mounted as `/api/email/welcome`)
- On checkout: `api/stripe-webhook.js` checkout.session.completed
- On schedule: `api/cron/email-triggers.js` (runs daily via Vercel cron)

Pattern:

```js
import { myNewEmail } from "./_lib/email-templates.js";
import { sendEmail } from "./_lib/email-send.js";

const tpl = myNewEmail({ name: ctx.name });
await sendEmail({
  userId, to: email, template: "my_new_email",
  dedupeKey: "my_new_email_" + somethingUnique,
  subject: tpl.subject, html: tpl.html, text: tpl.text,
  marketing: false,
});
```

#### Step 3: Deploy

Open a PR. Once merged to main, Vercel auto-deploys. New email is live.

### How to update an existing Resend template

1. Open `api/_lib/email-templates.js`
2. Find the function (e.g. `welcome`, `trialDay7`, `paymentFailed`)
3. Edit the `subject`, `headline`, or `body` strings
4. PR → merge → Vercel deploys → next send uses the new copy

**Important:** the `email_sends` dedup table keys on `template` (the
function name). If you change a template's purpose enough that previously-
sent users *should* get it again, you'll need a NEW dedup key or even a
NEW template function — otherwise the existing rows in `email_sends` will
block re-sends.

### How to test a template

You have an admin-only preview endpoint at `/api/email/preview` (see
`api/email/preview.js`). On the admin Dashboard tab in the app, the
"Email preview" button opens a page listing all templates with rendered
samples — sends nothing, just renders the HTML.

For end-to-end testing: trigger the actual scenario (sign up, complete a
checkout, etc.) with a `+test` Gmail alias. Check the inbox AND check
Resend Dashboard → Emails for delivery status.

### Current Resend templates (full inventory)

All defined in `api/_lib/email-templates.js`:

| Function | Subject (current) | Where it fires |
|---|---|---|
| `welcome` | "Welcome to VIRL" | `/api/email/welcome` — on first SIGNED_IN |
| `trialDay7` | (see file) | cron `email-triggers.js` |
| `trialDay11` | (see file) | cron `email-triggers.js` |
| `trialDay13` | (see file) | cron `email-triggers.js` |
| `trialExpired` | (see file) | cron `email-triggers.js` |
| `subscriptionWelcome` | "Welcome to VIRL [Plan]" | stripe-webhook (being removed in CX-FIX 5 — moving to Loops) |
| `paymentFailed` | "Payment couldn't be processed" | stripe-webhook past_due |
| `subscriptionCancelled` | "Your VIRL subscription is cancelled" | stripe-webhook subscription.deleted |
| `weeklyReset` | (see file) | cron `email-triggers.js` |
| `playbookDraftsReady` | (admin) | cron `playbook-refresh.js` |
| `phase1NoPlan` | (see file) | cron `email-triggers.js` |
| `firstPlanGenerated` | (see file) | inline in chat.js |
| `inactive7Day` | (see file) | cron `email-triggers.js` |
| `sundayLogNudge` | (see file) | cron `email-triggers.js` |
| `inactive30Day` | (see file) | cron `email-triggers.js` |
| `renewalUpcoming` | (see file) | stripe-webhook invoice.upcoming |
| `accountDeleted` | "VIRL account closed" | `/api/delete-account` |
| `referralMilestone` | (see file) | inline in chat.js |
| `passwordChanged` | "Your VIRL password was changed" | `/api/email/password-changed` (CX-FIX 1) |

### Resend pricing notes

Free tier: 3,000 emails/month, 100/day. After that, $20/month for 50k
emails. Transactional sending is well within the free tier for any
launch — VIRL won't hit limits until significant scale.

---

## 3. Loops — setup, automations, campaigns

### What Loops does for VIRL

Drives lifecycle and marketing email through an event-based pipeline.
VIRL fires events into Loops (via the Loops API); Loops decides which
automations / emails to trigger based on those events and contact
properties.

### Required env vars

| Variable | Purpose | Where set |
|---|---|---|
| `LOOPS_API_KEY` | Loops API authentication | Vercel → Production |

Get the key from: Loops Dashboard → Settings → API → Create API key →
copy. Paste into Vercel.

If `LOOPS_API_KEY` is missing, every Loops event silently no-ops
(see `api/_lib/loops.js` line 10: `loopsApiKey()` check). The app
never crashes from a missing key.

### Event-driven architecture

VIRL fires events into Loops via two helpers in `api/_lib/loops.js`:

```js
import { sendLoopsEvent, updateLoopsContact } from "./_lib/loops.js";

// One-shot event — drives automations / Loops in the Loops dashboard
await sendLoopsEvent({
  userId, email, eventName: "subscriptionStarted",
  properties: { firstName, planType, foundingTier, foundingPosition },
});

// Update contact properties — drives segmentation
await updateLoopsContact({
  userId, email,
  properties: { plan, planType, foundingTier, foundingPosition },
});
```

Loops resolves the contact by `userId` first, then `email`. Always send
both when you have them.

### Current events VIRL fires into Loops

| Event | When | Properties |
|---|---|---|
| `subscriptionStarted` | Checkout completes | `firstName`, `planType`, `foundingTier`, `foundingPosition`, `isFoundingMember` |
| `subscriptionCancelled` | Subscription deleted | `firstName`, `foundingTier` |
| `foundingCircleFull` | 50th FC spot claimed | `filledCount` (always 50) |
| `thirtyDayMilestone` | Cron, 30 days after signup | (varies) |

Plus contact properties auto-synced: `plan`, `planType`, `foundingTier`,
`foundingPosition`, `isFoundingMember`.

### Connecting Loops to VIRL — initial setup

1. **Create the Loops account.** loops.so → sign up → confirm email.
2. **Get the API key.** Settings → API → Create API key → copy.
3. **Set the env var.** Vercel → Settings → Environment Variables →
   Add `LOOPS_API_KEY` (Production scope) → paste → save → redeploy.
4. **Verify the connection.** Trigger an event in production (any
   subscription start). Within seconds, check Loops Dashboard →
   Contacts → search by email — the contact should exist with the
   properties listed above.

### How to view events in Loops

Loops Dashboard → **Events** (left sidebar). Lists every event that's
fired across all contacts, with timestamps. Click any event to see its
properties.

If you don't see expected events:
- Check Vercel function logs for `[loops]` messages
- Confirm `LOOPS_API_KEY` is set on Production scope
- Confirm the event name in code matches what you're filtering by

### How to create a transactional email in Loops

1. Loops Dashboard → **Transactional** → **Create transactional email**
2. Name it (internal label, not user-facing)
3. Compose the email in the visual editor
4. Use `{{firstName}}`, `{{planType}}`, `{{foundingPosition}}`, etc. as
   personalization tokens — they map to event/contact properties
5. Save → activate
6. To send it from VIRL, the code already fires the events; you just
   build the Loops "loop" / automation to listen for them (next section)

### How to create an automation (Loop) triggered by an event

1. Loops Dashboard → **Loops** → **Create loop**
2. Choose **Event** as the trigger → select `subscriptionStarted` (or
   whichever)
3. (Optional) Add a **filter** to branch:
   - Property: `foundingTier`
   - Operator: equals
   - Value: `founder_circle`
4. Add an **email** step → compose or pick an existing transactional
5. Optionally add **delay** steps (e.g. "wait 3 days, then send second
   email")
6. Optionally add **conditional** branches (e.g. "if opened, send X; if
   not, send Y")
7. Save → activate

### How to create a campaign (broadcast)

For sending a one-off email to many contacts at once (e.g. the
"Founder Circle is full" announcement to your waitlist).

1. Loops Dashboard → **Campaigns** → **Create campaign**
2. Choose recipients:
   - **All contacts** (rare)
   - **Audience / segment** (filter by properties — e.g. `plan = "free"`)
   - **Specific list** (uploaded or built from filters)
3. Compose the email
4. Schedule or send immediately

### How to use contact properties for segmentation

Build a **segment** in Loops Dashboard → **Audiences** → **Create
audience**:

| Segment | Filter | Use case |
|---|---|---|
| Founder Circle members | `foundingTier = founder_circle` | Office Hours reminders, beta announcements |
| All paying customers | `plan IN ("founding", "standard")` | Product-update emails |
| Annual subscribers | `planType = annual` | Annual-specific campaigns |
| Free + trial users | `plan = "free"` (or unset) | Conversion campaigns |
| Cancelled but reachable | `plan = "cancelled"` | Win-back campaigns |

Once a segment is created, you can use it as the audience for any
campaign.

### Loops pricing notes

Free tier: 1,000 emails/month, 250 contacts. Paid starts at $49/month
for 5k emails + 1.5k contacts. Decent room for launch; you'll likely
upgrade in month 2-3 as the user base grows.

---

## 4. Supabase Auth emails (separate system)

Supabase Auth sends a few emails on its own, completely separate from
Resend and Loops. You configure them in Supabase Dashboard, not in code.

### Emails Supabase Auth sends

| Email | Trigger | Where to customize |
|---|---|---|
| Confirm signup | New user signs up (email confirmation required) | Supabase Dashboard → Authentication → Email Templates → "Confirm signup" |
| Reset password | User clicks "Forgot password" | Supabase Dashboard → Authentication → Email Templates → "Reset password" |
| Magic link | Magic link sign-in (not currently used) | Supabase Dashboard → Authentication → Email Templates → "Magic link" |
| Change email | User initiates email-change | Supabase Dashboard → Authentication → Email Templates → "Change Email Address" |

### Recommended action

Visit **Supabase Dashboard → Authentication → Email Templates** and
customize at least:

1. **Confirm signup** — the default copy is bare. Match VIRL's voice:
   `Subject: Confirm your VIRL account`
   `Body: Tap the link below to confirm your email and finish setting up your VIRL account. — Lauren`

2. **Reset password** — same:
   `Subject: Reset your VIRL password`
   `Body: Tap the link to set a new password. If you didn't ask for this, you can ignore this email.`

### Why these aren't in Resend or Loops

Supabase Auth signs the email links with rotating secrets. To handle
that securely outside Supabase, you'd need to build a whole auth
forwarding layer. Not worth it — Supabase's emails are fine, just
customize the copy.

---

## 5. Email content library

Recommended subject lines and body copy for every email VIRL should
send. Use these as starting points; iterate based on open rates.

### Account & auth (Resend / Supabase)

#### Welcome (signup) — `welcome` template
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

```
Subject: It's been a month

{{firstName}}, it's been 30 days since you used VIRL. I'm not going to
bug you — but if something specific drove you away, I'd love to hear
about it.

Reply with one line, or just ignore this and I'll get the message.

— Lauren
```

#### Sunday log nudge

```
Subject: Sunday log — 30 seconds

{{firstName}}, you've got {{unloggedCount}} unlogged posts from this
week. VIRL learns from what you logged — better data, better plans.

[Log it now →]

Takes about 30 seconds.

— Lauren
```

#### First plan generated

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

```
Subject: VIRL playbook drafts ready for review ({{count}})

{{count}} new platform-playbook drafts are waiting in the Admin tab.

[Summaries]

Review and approve in the Admin dashboard.
```

---

## 6. Migration plan: Resend → Loops over time

Move emails in phases. Each phase has a clear win and is independently
reversible.

### Phase 0 (pre-launch — happening now)

- Founder Circle suite: welcome (FC + Standard variants), payment
  confirmation (FC + Standard), Office Hours invite, "Founder Circle
  is full" campaign
- Status: in flight (Loops setup guide #100, code event firing #99,
  Resend welcome being disabled in #106)

### Phase 1 (month 1 post-launch)

- Trial sequence: day 7, day 11, day 13, expired
- Why: trial copy is constantly iterated to find what converts. Loops
  visual editor + A/B testing makes this dramatically faster than
  Resend code changes.

How to migrate one template:
1. Build the email in Loops
2. Build a Loop triggered by the same event the Resend cron fires on
   (or by a new event the cron now fires into Loops instead of sending
   directly)
3. **Disable the Resend send** in the cron — replace the `sendEmail`
   call with `sendLoopsEvent`
4. Deploy
5. Verify in Loops that the next scheduled send went out
6. Delete the Resend template function once a week passes without
   issues

### Phase 2 (month 2-3)

- Re-engagement: `inactive_7d`, `inactive_30d`
- Engagement: `weekly_reset`, `sunday_log`, `phase1_no_plan_24h`
- Milestones: `first_plan_generated`, `referral_milestone`

Same migration pattern as Phase 1.

### Stays in Resend forever

- `password_changed` (security)
- `payment_failed` (action required)
- `renewal_upcoming` (action required)
- `account_deleted` (irreversible-action receipt)
- `playbook_drafts_ready` (internal admin)

Plus Supabase Auth's signup confirmation + password reset link emails
stay in Supabase.

---

## 7. Quick reference

### Decision tree: which system for a new email?

```
Is the email security or billing critical?
├── Yes → Resend
└── No
    ├── Is it part of an automated sequence or campaign?
    │   ├── Yes → Loops
    │   └── No
    │       └── Will the copy change often? (>1x per quarter)
    │           ├── Yes → Loops
    │           └── No → Either, but default to Loops for new lifecycle stuff
```

### Checklist for adding a new email

**Resend:**
- [ ] Template function added in `api/_lib/email-templates.js`
- [ ] `sendEmail` call added at the trigger point
- [ ] Dedup key strategy chosen and documented
- [ ] Tested via `/api/email/preview`
- [ ] End-to-end tested via a real trigger
- [ ] PR merged to main → Vercel deployed

**Loops:**
- [ ] Event being fired by the code? (Check `sendLoopsEvent` call sites)
- [ ] If new event needed, added in code + deployed
- [ ] Email composed in Loops dashboard
- [ ] Automation (Loop) or campaign created in Loops
- [ ] Filter conditions set if branching by property
- [ ] Activated in Loops
- [ ] Tested end-to-end with a real trigger
- [ ] Verified in Loops Events log

### Common pitfalls

- **Double-emails.** If both Resend and Loops fire for the same trigger,
  subscribers get two emails. Pick one system per email and stick to it.
- **Stale events.** If you fire a new event in code but the Loops
  automation doesn't exist yet, the event lands silently — nothing
  sends. Always set up the Loops side before deploying the event.
- **Dedup mismatch.** If you change a Resend template's purpose, but
  reuse the same dedup key, users who already received the old one
  won't get the new one. Use a new dedup key.
- **Missing API key.** Both systems silently no-op if their key isn't
  set. Always confirm `RESEND_API_KEY` and `LOOPS_API_KEY` are set on
  Production scope after any env-var work.
- **Supabase Auth emails forgotten.** Signup confirmation and password
  reset emails are *not* in Resend or Loops — they're in Supabase
  Dashboard. Customize them there.

### Env vars summary

| Variable | System | Required for |
|---|---|---|
| `RESEND_API_KEY` | Resend | All Resend sends |
| `EMAIL_FROM` | Resend | Default From address |
| `LOOPS_API_KEY` | Loops | All Loops events |
| `SUPABASE_URL` | both | Dedup table (Resend), contact lookups |
| `SUPABASE_SERVICE_KEY` | both | Dedup table (Resend), contact lookups |

### Where to look when something's broken

| Symptom | Look here |
|---|---|
| User reports no email arrived (Resend) | Vercel function logs for `[email]` lines, then Resend Dashboard → Emails |
| User reports no email arrived (Loops) | Loops Dashboard → Events (was it fired?), then the Loop's send history |
| Two emails for one event | Probably both Resend and Loops are firing — disable one |
| Email arrives but copy is wrong | Resend: edit `email-templates.js`, deploy. Loops: edit in dashboard, save |
| Sender domain warnings | Resend Dashboard → Domains → verify DNS records still valid |
| User in wrong segment | Loops Dashboard → Contacts → search by email → check properties; check that `updateLoopsContact` is firing on the right events |

---

**End of guide.** Update this doc when you change email infrastructure,
add a new template, or change the Resend/Loops split for any email.
