# VIRL — Loops Setup Guide: Founder Circle

Everything you need to set up in Loops for the Founder Circle pricing launch.
The app fires events into Loops; you build the automations that listen for
them. Nothing here requires further code changes — it's all Loops dashboard
work.

---

## ⚠️ Read first: avoid double-emails

The VIRL app sends some emails **directly via Resend** (transactional), separate
from Loops. Today the code Resends these on its own:

| Resend email | Sent when |
|---|---|
| `subscription_welcome` | checkout completes |
| `payment_failed` | a payment fails |
| `subscription_cancelled` | subscription is cancelled |
| `renewal_upcoming` | ~3-7 days before renewal |

**If you also build a Welcome email in Loops, new subscribers get two welcomes.**
Decide the split before building:

- **Option A (recommended):** Loops owns the lifecycle/marketing emails (welcome,
  payment confirmation, Office Hours). Resend keeps only the pure-utility ones
  (payment failed, renewal). → Requires a small code change to switch off the
  Resend `subscription_welcome`. Ask Claude to do this.
- **Option B:** Resend keeps the transactional welcome; Loops only handles the
  *new* Founder Circle pieces (Office Hours, "circle is full", beta). No welcome
  email in Loops at all.

This guide is written for **Option A**. If you pick B, skip emails 1-4 below.

---

## Events the app fires into Loops

### `subscriptionStarted`
Fires the moment a checkout completes, on the new subscriber's contact.

| Property | Type | Example |
|---|---|---|
| `firstName` | string | `"Jordan"` (may be empty) |
| `planType` | string | `"monthly"` or `"annual"` |
| `foundingTier` | string | `"founder_circle"` or `"standard"` |
| `foundingPosition` | number | `7` (1-50) — `0` for Standard or overflow |
| `isFoundingMember` | boolean | `true` / `false` |

### `foundingCircleFull`
Fires **once**, when the 50th Founder Circle spot is claimed.

| Property | Type | Example |
|---|---|---|
| `filledCount` | number | `50` |

### `subscriptionCancelled`
Fires when a subscription is cancelled.

| Property | Type | Example |
|---|---|---|
| `firstName` | string | `"Jordan"` |
| `foundingTier` | string | `"founder_circle"` or `"standard"` |

### Contact properties (synced on signup + cancel)
`plan`, `planType`, `foundingTier`, `foundingPosition`, `isFoundingMember` —
use these to build segments (see bottom of guide).

---

## Emails to build

### 1. Welcome — Founder Circle variant
- **Trigger:** `subscriptionStarted` event
- **Filter:** `foundingTier` is `founder_circle`
- **Personalize with:** `firstName`, `foundingPosition`
- **Suggested copy:**
  > Welcome to the Founder Circle — you're Founder #{foundingPosition}, one of
  > the first 50.
  >
  > Your pricing is locked at $20/month for as long as you're with VIRL.
  > Forever. The Office Hours invitation is coming separately.
  >
  > Email me anytime at hello@govirl.ai — that's a real direct line, not a
  > support queue.
  >
  > — Lauren

### 2. Welcome — Standard variant
- **Trigger:** `subscriptionStarted` event
- **Filter:** `foundingTier` is `standard`
- **Copy:** your existing standard welcome copy, unchanged.

### 3. Payment confirmation — Founder Circle variant
- **Trigger:** `subscriptionStarted` event (a later step in the same Loop, or a
  separate Loop)
- **Filter:** `foundingTier` is `founder_circle`
- **Should include:** confirmation that $20/month pricing is permanent, a note
  about monthly Office Hours, and the hello@govirl.ai direct line.

### 4. Payment confirmation — Standard variant
- **Trigger:** `subscriptionStarted` event
- **Filter:** `foundingTier` is `standard`
- **Copy:** standard payment confirmation, unchanged.

### 5. "The Founder Circle is full" — campaign
- **Trigger / signal:** the `foundingCircleFull` event fires when spot #50 is
  taken. **Note:** this event lands on the 50th member's contact only — it is
  *not* a broadcast. To reach your whole audience, set this up as a **Loops
  campaign** to the segment "waitlist + Standard customers" and send it when you
  see `foundingCircleFull` fire (the Step 8 monitoring dashboard will also show
  the fill count).
- **Copy** (from the brief — fill in the actual day count yourself):
  > The Founder Circle filled in [X days]. Thank you to the 50 people who
  > believed in VIRL first.
  >
  > Standard pricing now applies for everyone — $25/month or $249/year.
  > The Founder Circle is closed for good. There won't be another.
  >
  > If you've been waiting, this is your sign to try VIRL free for 14 days.
  > No credit card required.
  >
  > — Lauren

### 6. Office Hours invite
- **Trigger:** `subscriptionStarted` event
- **Filter:** `foundingTier` is `founder_circle`
- **Content:** invite to the monthly Founder Office Hours.
  - **When:** last Friday of every month, 8:00 AM CT, 45 minutes, Zoom
  - **First call:** Friday, June 26, 2026
  - Recorded for anyone who can't attend live
- Include the Zoom link once you have it.

### 7. Office Hours monthly reminder
- **Trigger:** recurring/scheduled in Loops (not event-driven) — e.g. a few days
  before the last Friday each month
- **Audience:** the "Founder Circle members" segment
- **Content:** reminder of the date/time + Zoom link.

### 8. Office Hours post-call summary
- **Trigger:** sent manually by Lauren after each call
- **Audience:** the "Founder Circle members" segment
- **Content:** recap + link to the recording.

### 9. Beta feature announcement (future — not needed for launch)
- **Trigger:** sent manually when a beta ships (first one: Sunday Review,
  month 4-5)
- **Audience:** the "Founder Circle members" segment
- Build this later; noted here for completeness.

---

## Segment to create

**Founder Circle members**
- Condition: contact property `foundingTier` equals `founder_circle`
- Drives emails 7, 8, 9.

---

## To remove

**Year-2 transition email** — Founder Circle pricing is permanent (no year-2
price change), so this automation is obsolete. Delete it from your Loops flow.

---

## Setup checklist

- [ ] Decide Option A vs B (double-email split)
- [ ] If Option A: ask Claude to switch off the Resend `subscription_welcome`
- [ ] Email 1 — Welcome, Founder Circle variant
- [ ] Email 2 — Welcome, Standard variant
- [ ] Email 3 — Payment confirmation, Founder Circle variant
- [ ] Email 4 — Payment confirmation, Standard variant
- [ ] Email 5 — "Founder Circle is full" campaign
- [ ] Email 6 — Office Hours invite
- [ ] Email 7 — Office Hours monthly reminder
- [ ] Email 8 — Office Hours post-call summary (template ready to send)
- [ ] Segment — "Founder Circle members" (`foundingTier = founder_circle`)
- [ ] Remove the year-2 transition email
- [ ] Email 9 — beta announcement (defer to month 4-5)
