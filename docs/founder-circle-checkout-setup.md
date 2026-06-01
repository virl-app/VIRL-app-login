# VIRL — Founder Circle Checkout Setup (account-first)

The "Claim my Founder Circle spot" funnel runs **entirely inside the app**:
sign up first, then pay. Abandoning payment leaves the user on the free trial
and **does not consume a Founder Circle spot** — the position is only claimed
when Stripe confirms payment (`checkout.session.completed`).

```
Marketing CTA  →  app signup form  →  (account created, free trial by default)
   ├─ intent=founder  →  auto-redirect to Stripe Founder Circle checkout
   │        ├─ pays      →  webhook sets plan='founding' + claims position
   │        └─ cancels   →  back in the app on the free trial (no spot used)
   └─ intent=trial    →  one-screen Founder Circle offer (the upgrade modal)
            ├─ "Claim my spot"   →  Stripe FC checkout (as above)
            └─ "Maybe later"     →  free trial
```

This replaces the earlier payment-first / Stripe Payment Link approach (no
`/welcome`, no magic-link auto-login, no `user_metadata.is_founder_circle`).
Source of truth for membership stays `credits.founding_tier` / `credits.plan`.

---

## 1. Marketing-site CTAs (the only change on govirl.ai)

Point the two buttons at the app signup with an `intent` param:

| Button | URL |
|---|---|
| **Claim my Founder Circle spot** | `https://app.govirl.ai/?signup=true&intent=founder&plan=annual` |
| **Start a free trial** | `https://app.govirl.ai/?signup=true&intent=trial` |

- `signup=true` opens the form in signup mode (existing behavior).
- `intent=founder` → after the form, the app sends them straight to Stripe FC
  checkout.
- `intent=trial` → after the form, the app pops the one-screen FC offer.
- `plan=annual|monthly` (optional, defaults to `annual`) preselects the cadence.

Existing UTM / `ref` params still work alongside these.

## 2. Stripe (no new objects)

Uses the **existing** `create-checkout` + webhook. Confirm these env vars are
set (they already drive the in-app upgrade modal):

- `STRIPE_PRICE_FOUNDER_MONTHLY`, `STRIPE_PRICE_FOUNDER_ANNUAL`
- `STRIPE_PRICE_STANDARD_MONTHLY`, `STRIPE_PRICE_STANDARD_ANNUAL`
- `STRIPE_SECRET_KEY` (or `STRIPE_RESTRICTED_KEY`), `STRIPE_WEBHOOK_SECRET`

`create-checkout.js` already sets `cancel_url` back to the app, so a cancelled
Stripe session returns the user to their free trial automatically. No Payment
Link, no `/welcome` route, no Supabase redirect-allowlist change needed.

## 3. The 50-seat cap (advisory)

`create-checkout.js` checks `founding_positions` before creating the session
and the `claim_founding_position` RPC assigns the numbered slot atomically on
payment. Because the check and the payment are seconds apart, a burst at seat
~49 can oversell by 1–2; those overflow buyers get Founder pricing but
`founding_position = NULL` (the documented overflow window). If an exact cap
is ever required, switch to reserve-at-checkout + release on
`checkout.session.expired`.

## 4. Out of scope (unchanged)

- Founder Circle perks (Office Hours, beta access) — flag stored only.
- "Manage subscription" UI — Stripe Customer Portal (separate task).
- Standard subscription flow and the non-FC trial-end paywall.
