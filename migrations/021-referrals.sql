-- [REFERRAL] Give-a-month / get-a-month referral program.
-- Both tables are service-role only (RLS enabled, no policies) — all
-- reads/writes go through api/referral.js, create-checkout, and the
-- Stripe webhook using the service key, matching email_sends' posture.

create table if not exists public.referral_codes (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  code       text not null unique,
  created_at timestamptz not null default now()
);
alter table public.referral_codes enable row level security;

create table if not exists public.referrals (
  id               bigint generated always as identity primary key,
  code             text not null,
  referrer_user_id uuid not null references auth.users(id) on delete cascade,
  -- unique: an account can be referred at most once, and never retroactively re-attributed
  referred_user_id uuid not null unique references auth.users(id) on delete cascade,
  -- signed_up → converted (referred user paid) → referrer_rewarded (month granted)
  status           text not null default 'signed_up'
                   check (status in ('signed_up','converted','referrer_rewarded')),
  created_at       timestamptz not null default now(),
  converted_at     timestamptz,
  rewarded_at      timestamptz
);
alter table public.referrals enable row level security;
create index if not exists referrals_referrer_idx on public.referrals (referrer_user_id, status);
