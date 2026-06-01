# VIRL — Founder Circle Payment-First Checkout Setup

The automated "Claim my Founder Circle spot" flow: marketing CTA → Stripe
Payment Link → pay → auto-account + auto-login → dashboard with Founder Circle
active. The app side is implemented; this is the dashboard wiring Lauren owns.

```
Marketing CTA  →  Stripe Payment Link  →  user pays
   →  Stripe redirect to app.govirl.ai/welcome?session_id=cs_xxx
   →  /welcome creates the account + magic-link auto-login
   →  dashboard (Founder Circle active)

Safety net: if the user closes the tab before /welcome, the Stripe webhook
(checkout.session.completed) backfills the account and emails a magic link.
```

---

## 1. Stripe dashboard

**Price IDs** — already used by the existing checkout; reuse the same ones:

| Env var | What |
|---|---|
| `STRIPE_PRICE_FOUNDER_MONTHLY` | Founder Circle $20/mo price ID |
| `STRIPE_PRICE_FOUNDER_ANNUAL`  | Founder Circle $215/yr price ID |

`/welcome` and the webhook validate the checkout line item against these two —
a payment for any other price is rejected, so this doubles as the allowlist.

**Create the Payment Link** (Stripe → Payment Links → New):

- Product: the Founder Circle price ($20/mo or $215/yr).
- After payment → **Don't show confirmation page**; instead set the redirect:
  ```
  https://app.govirl.ai/welcome?session_id={CHECKOUT_SESSION_ID}
  ```
  Stripe substitutes `{CHECKOUT_SESSION_ID}` automatically — paste it literally.
- Point the marketing-site button at the Payment Link URL.

**Webhook** — the existing endpoint already handles this. Confirm
`checkout.session.completed` is in the webhook's enabled events. No new webhook
needed; `STRIPE_WEBHOOK_SECRET` is already set.

---

## 2. Supabase dashboard

**Redirect allowlist** (Authentication → URL Configuration → Redirect URLs):
the magic link lands the user at `https://app.govirl.ai/dashboard?fc=welcome`,
so that URL (or a wildcard like `https://app.govirl.ai/**`) must be allowlisted,
or Supabase will drop the redirect and fall back to the Site URL.

**Service key** — `SUPABASE_SERVICE_KEY` and `SUPABASE_URL` are already set;
the flow uses them to create users and mint magic links via the admin API.

---

## 3. How it behaves (no further code needed)

- **Happy path:** pay → `/welcome` → logged in at the dashboard. The dashboard
  shows a one-time "set a password" prompt (dismissible with "Maybe later",
  reappears next login until they set one).
- **Closed tab:** webhook creates the account and emails a "Welcome to the
  Founder Circle — log in" message with a magic link.
- **Existing trial account, same email:** `/welcome` detects it, upgrades the
  metadata + plan to Founder Circle, and logs them in. They already have a
  password, so no set-password prompt.
- **Forgot password / expired magic link:** standard "Forgot password" on the
  login screen sends a Supabase recovery email.

Source of truth for membership is `user_metadata.is_founder_circle`, mirrored
into `credits.plan = 'founding'` / `founding_tier = 'founder_circle'` so the
trial paywall is skipped and server-side gating treats them as paid.

---

## 4. Out of scope (separate tasks)

- Founder Circle perks (Office Hours calendar, beta access) — the flag is
  stored; surfacing comes later.
- "Manage subscription" UI — Stripe Customer Portal handles this once wired.
- Cap enforcement on the raw Payment Link: unlike the in-app checkout, a
  Payment Link can't pre-check the 50-seat cap. `claim_founding_position`
  still returns NULL past 50 (member gets the tier without a numbered slot —
  the documented overflow window).
