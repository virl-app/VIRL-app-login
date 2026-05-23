# VIRL — Customer Experience Audit (pre-launch)

Inventory of the customer-facing flows + email touchpoints, with gaps
identified ahead of the June 1 launch. Scope: account-management UX,
email coverage, self-service. Not scope: pricing rollout (separate
brief), marketing pages.

---

## TL;DR — what to fix before launch

| # | Issue | Severity | Effort |
|---|---|---|---|
| 1 | Password reset is broken end-to-end | 🚨 **P0** | ~1-2 hr |
| 2 | No Stripe Customer Portal — users can't manage their own subscription | 🚨 **P0** | ~1-2 hr |
| 3 | No "change password" UI for signed-in users | ⚠️ P1 | ~1 hr |
| 4 | No password-change confirmation email | ⚠️ P1 | ~30 min |
| 5 | No "change email" UI | ⚠️ P1 | ~1-2 hr |

Everything else (data export, MFA, login-from-new-device notifications, paid-user onboarding sequence) is real but defer-able past launch.

---

## What's already working

You actually have a substantial email surface — easy to underestimate.

### Resend (transactional, sent by the app)
- `welcome` — on signup
- `subscription_welcome` — on checkout completion
- `payment_failed` — on payment failure
- `subscription_cancelled` — on cancellation
- `renewal_upcoming` — 3-7 days before renewal
- `account_deleted` — on account deletion

### Resend (cron, scheduled)
- `trial_day_7`, `trial_day_11`, `trial_day_13`, `trial_expired` — trial lifecycle
- `weekly_reset` — weekly credit refill
- `phase1_no_plan_24h` — onboarding nudge if no plan generated in 24 hours
- `inactive_7d`, `inactive_30d` — re-engagement
- `sunday_log` — Sunday content-logging nudge

### Loops (event-triggered)
- `subscriptionStarted` (enriched with `foundingTier`, `foundingPosition`)
- `foundingCircleFull` (fires on the 50th claim)
- `subscriptionCancelled` (enriched)
- `thirtyDayMilestone`

### Supabase Auth (sent by Supabase itself)
- Signup email confirmation
- Password reset link
- (Magic link + email-change confirmation available, not currently used)

### Account-management UI today
- Sign up
- Sign in
- Forgot password (sends email — see P0 below)
- Delete account
- Sign out

That's the whole list. No change-password, no change-email, no manage-subscription, no profile-edit beyond the Creator Profile.

---

## Critical gaps

### 🚨 P0 — Password reset is broken end-to-end

**What works:** "Forgot password?" sends the reset email via `supabase.auth.resetPasswordForEmail`. The user gets the email with a link.

**What's broken:** When the user clicks the link, they land at `app.govirl.ai`. Supabase fires a `PASSWORD_RECOVERY` event. The app's `onAuthStateChange` handler **does not listen for this event** — it only handles `SIGNED_OUT`. The user is silently signed in via the recovery session with no UI to actually set a new password.

**User experience:** "I clicked the link… now what?" → confused → emails Lauren → bad first impression.

**Fix:**
1. Add a `PASSWORD_RECOVERY` case to the `onAuthStateChange` handler that flips the UI into "set new password" mode
2. Render a password-input + confirm form
3. On submit, call `supabase.auth.updateUser({ password: newPwd })`
4. Send a confirmation email (see P1 #4 below)
5. Redirect to the dashboard

**Effort:** 1-2 hours, contained to `index.html`.

### 🚨 P0 — No self-service billing (Stripe Customer Portal)

Customers cannot:
- Update their payment card
- View / download invoices
- Cancel their own subscription
- See their next renewal date

Every one of these forces an email to you. Annoying for the customer, time-tax for you.

**Fix:** Stripe ships a hosted **Customer Portal** that does all of this. Implementation:
1. Enable the Customer Portal in Stripe Dashboard → Settings → Billing → Customer portal (5 min, no code)
2. Add `/api/create-portal-session` that calls `stripe.billingPortal.sessions.create({ customer, return_url })` (15 min)
3. Add a "Manage subscription" button in the app (in the account area you'll need anyway — see P1 #3) that fetches the portal URL and redirects (10 min)

Result: users self-serve everything subscription-related. Industry standard.

**Effort:** 1-2 hours total.

---

## Important — should land before launch ideally

### ⚠️ P1 — No "change password" UI for signed-in users

Separate from the forgot-password flow. A signed-in user who *remembers* their password but wants to change it has no UI to do so today. Standard expectation in any SaaS app.

**Fix:** Add a "Change password" section in the account-management area. Calls `supabase.auth.updateUser({ password: ... })`. Same confirmation email as the P0 flow.

**Effort:** ~1 hour.

### ⚠️ P1 — No password-change confirmation email

Supabase doesn't send one by default. Security best-practice: when a password changes, the *old* email gets notified. If an attacker resets the password, the legitimate owner sees the email and can react.

**Fix:** Add a `passwordChanged` Resend template + send it from both the recovery flow (P0) and the change-password flow (P1 above).

**Effort:** ~30 min.

### ⚠️ P1 — No "change email" UI

Users are locked to their signup email. Common life events (job change, vendor email no longer accessible) make this break. Supabase has built-in support via `supabase.auth.updateUser({ email: ... })` — it triggers a dual-confirmation flow (new email gets a confirm link, old email gets a notice).

**Fix:** Add "Change email" to the account-management UI. Wire up the dual-confirmation handling.

**Effort:** 1-2 hours.

---

## Nice-to-have — defer past launch

### Data export (GDPR-style)
No flow for a user to download their data. Required by GDPR for EU users. Lower priority since most users won't ask, and you can fulfill ad-hoc via Supabase if asked. Build a self-serve "Export my data" button later.

### Multi-factor authentication (2FA)
Supabase Auth supports MFA, but not exposed in the UI. Reasonable to skip pre-launch — most users won't enable it, and it's optional for any creator account.

### Login-from-new-device notification
Security best-practice ("New sign-in from Chrome on Mac in Austin, TX"). Not native in Supabase. Would require building. Defer.

### Paid-user onboarding sequence
`subscription_welcome` is one email. A 3-5 email "get the most out of VIRL" sequence in the first 14 days post-upgrade would meaningfully improve retention. Loops territory. Defer to post-launch when you have real signups to learn from.

### Cancellation win-back
The webhook code comment references a "day-60 reactivation segment" in Loops — this is intended but not built. Loops-side work; can add to the Loops setup guide. Worth doing in the first month post-launch.

### Refund acknowledgment
When you refund someone, Stripe sends a receipt. The app doesn't send anything. Low priority — the Stripe receipt is sufficient.

---

## Founder Circle gaps (already covered)

The Founder Circle Loops setup is documented separately in
`docs/loops-founder-circle-setup.md` (PR #100). That guide lists all the
Founder Circle-specific emails you'll need to build in Loops.

---

## Recommended order

For a clean June 1 launch, prioritize:

1. **Fix password reset** (P0) — 1-2 hr
2. **Add Stripe Customer Portal** (P0) — 1-2 hr
3. **Add change-password UI** (P1) — 1 hr
4. **Add password-change confirmation email** (P1) — 30 min
5. **Decide Option A/B on the Loops welcome split** (5 min) — switches off Resend `subscription_welcome` if A

Total: ~4-6 hours of focused work. All fittable into one PR per item, reviewable in pieces.

Change-email + the nice-to-haves can land in the first month post-launch.
