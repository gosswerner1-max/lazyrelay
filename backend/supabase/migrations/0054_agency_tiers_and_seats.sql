-- Agency pricing pass (2026-08-17) — prices what Agency-tier-v1
-- (account_members, migration 0053) shipped uncapped. Two new self-serve
-- tiers above Business ($99.99/enterprise): Agency ($149.99) and Agency
-- Plus ($199.99). Business also gets a seat allowance for the first time.
-- Fun footnote: 0001_init_schema.sql's very first, since-abandoned tier
-- scheme once used 'agency' as a tier code too (superseded by 0006's
-- free/pro/business rename) — pure historical coincidence, no collision
-- with the currently-live constraint this alters.
alter table subscriptions drop constraint subscriptions_tier_check;
alter table subscriptions add constraint subscriptions_tier_check
  check (tier in ('free', 'pro', 'business', 'enterprise', 'agency', 'agency_plus'));

-- Seat add-ons, identical shape to brand_addons (0048) -- each is its own
-- Paddle subscription, stackable, cancelling one doesn't touch the main
-- plan. Unlike brand add-ons (capped at 10 active), seat add-ons are
-- capped at +2 per account regardless of tier (see MAX_SEAT_ADDONS_PER_ACCOUNT
-- in seatLimits.ts) -- a much smaller overflow buffer, a deliberate choice
-- since included seat counts already do most of the tier differentiation.
create table seat_addons (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  mor_subscription_id text not null unique,
  status text not null check (status in ('trialing', 'active', 'past_due', 'cancelled')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index seat_addons_account_id_idx on seat_addons (account_id);

-- No client-facing RLS policies, same fail-closed-by-omission pattern as
-- brand_addons/storage_addons/oauth_states/media_uploads -- only the
-- backend's service-role client ever touches this table.
alter table seat_addons enable row level security;
