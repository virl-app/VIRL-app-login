# Email runbook

Setup, configuration, and what to do when something's wrong. Operational only —
principles live in `stance.md`, open questions in `decisions.md`.

## The three systems

Mail goes out under VIRL's name from three places. Knowing which one sent a
given email is the first step in almost every investigation.

| System | Owns | Visible in repo? |
|---|---|---|
| **Resend** | everything in `api/_lib/email-templates.js` | yes — templates and conditions in code, sends logged in `email_sends` |
| **Loops** | events fired from code; the email itself lives in a dashboard | event firing only — copy, timing, and audience are not in the repo |
| **Supabase Auth** | signup confirmation, password reset, magic link | no — configured in the Supabase dashboard |

**If there's no `email_sends` row, it wasn't Resend.** That single check
resolves most "where did this come from" questions.

## Env vars

| Variable | System | Required for |
|---|---|---|
| `RESEND_API_KEY` | Resend | all Resend sends |
| `EMAIL_FROM` | Resend | default From address |
| `EMAIL_FROM_FOUNDER` | Resend | founder-voice From (defaults from `EMAIL_FROM`) |
| `LOOPS_API_KEY` | Loops | all Loops events |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | both | dedupe table, contact lookups |
| `CRON_SECRET` | cron | authenticates the scheduled invocations |
| `EMAIL_VIA_LOOPS` | both | **changes which system owns the trial sequence** — see `decisions.md` |

Both providers **silently no-op** without their key. After any env work,
confirm `RESEND_API_KEY` and `LOOPS_API_KEY` are set on Production scope.

`EMAIL_VIA_LOOPS` cannot be read from the repo. Check Vercel before concluding
an email "isn't firing."

## Cron schedule

Two invocations of the same endpoint, and mixing them up is the classic
debugging mistake:

| Schedule | Query | Runs |
|---|---|---|
| `0 14 * * *` | — | `processUser()` — all lifecycle mail |
| `30 23 * * *` | `?job=reminders` | `processReminderUser()` — **only** `posting_reminder` and `sunday_reset` |

An email that arrived around 6:30 PM CT came from the reminder pass. Anything
else came from the lifecycle pass. The gate between them is load-bearing —
running both in one invocation would re-fire every lifecycle trigger.

## Previewing without sending

`api/email/preview.js` renders any template in a browser. Every new template
must be registered there — it's the only way to see an email before a customer
does, and for anything with a long trigger window (a six-month milestone, say)
it's the only way to see it at all.

## Adding a template

1. Write it in `api/_lib/email-templates.js` and classify its voice in the
   header comment.
2. If it's signed by Lauren, add the slug to `FOUNDER_VOICE_TEMPLATES` in
   `api/_lib/email-send.js`. The From line and the signature have to agree.
3. Add the trigger beside the existing ones in `api/cron/email-triggers.js` so
   it inherits the shared eligibility computation. A trigger added to a
   function that doesn't compute trial state is how the Sunday reset shipped
   broken.
4. Register it in `api/email/preview.js`.
5. Choose the dedupe key deliberately: static means once per user ever, a
   date/week/month suffix means it recurs. Default to static.
6. If it's unbuilt but specified, record it in `decisions.md` as NOT BUILT
   rather than describing it in `stance.md`.

Dedupe is enforced by a unique index on `(user_id, template, dedupe_key)` in
`email_sends`.

## Debugging

| Symptom | Where to look |
|---|---|
| Which email is this? | subject line → `api/_lib/email-templates.js`; every subject is distinctive |
| Did we send it, and how often? | `select template, dedupe_key, sent_at from email_sends where user_id = '<uuid>' order by sent_at desc` — the dedupe key tells you the cadence immediately |
| Nothing arrived (Resend) | Vercel logs for `[email]` lines, then Resend dashboard → Emails |
| Nothing arrived (Loops) | Loops dashboard → Events (did it fire?), then the Loop's send history |
| Two emails for one trigger | Resend and Loops both firing — check `EMAIL_VIA_LOOPS` |
| Nothing arrived, no error | marketing-classified send to an opted-out user; check `email_preferences.marketing_opt_out` |
| Copy is wrong | Resend: edit the template, deploy. Loops: edit in the dashboard |
| Wrong segment | Loops → Contacts → search by email → check properties; confirm `updateLoopsContact` is firing |

## Common pitfalls

- **Stale events.** Firing a new Loops event in code before the automation
  exists means it lands silently and nothing sends. Set up the Loops side
  first.
- **Reused dedupe keys.** Repurposing a template while keeping its key means
  everyone who got the old one never gets the new one. New purpose, new key.
- **Supabase Auth forgotten.** Signup confirmation and password reset are not
  in Resend or Loops. Customise them in the Supabase dashboard.
- **Cron auth.** The endpoint rejects anything without
  `Authorization: Bearer ${CRON_SECRET}`. A misconfigured secret fails the
  whole run, logged by `cronAuthorized`.

## Deliverability — non-negotiables

- [ ] **DMARC** at `p=quarantine` minimum, ideally `p=reject`.
- [ ] **SPF + DKIM aligned** for every sending domain in use.
- [ ] **Google Postmaster Tools** configured; weekly check.
- [ ] **Microsoft SNDS** configured for the sending IP range.
- [ ] **List-Unsubscribe + List-Unsubscribe-Post** headers on every marketing
      email. The endpoint is `api/email/unsubscribe.js` — wire it into Loops's
      sending too.
- [ ] **Physical mailing address** in every marketing footer (CAN-SPAM).
- [ ] **Hard-bounce auto-suppression** on in both providers; confirm quarterly.
- [ ] **Sender reputation pre-check** before any send over 1,000 recipients.
      Below "High" in Postmaster, delay.
- [ ] **No purchased lists, ever.** The fastest way to destroy a sending
      domain.

## When to pause everything

Stop all non-transactional sending and investigate if any of these hold: spam
complaint rate above 0.1%, hard-bounce rate above 2%, Postmaster reputation
drops below "Medium," or a send goes out to the wrong audience. Transactional
mail continues — people still need receipts and password resets.
