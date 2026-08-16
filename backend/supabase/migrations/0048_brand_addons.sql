-- Phase 1b (2026-08-16) — paid per-brand overage, so a paying customer can
-- exceed their plan's included brand count without a full tier jump. Mirrors
-- storage_addons (migration 0012) exactly: each add-on is its OWN Paddle
-- subscription (not folded into the tier subscription), because a customer
-- can stack several, and cancelling one must not touch the main plan.
--
-- Unlike storage add-ons (which come in 5/20/50GB sizes), a brand add-on has
-- no size — it's a flat +1 brand slot per add-on at one fixed price
-- (~$10/mo, anchored to SocialBee's own $10/workspace add-on and Later's
-- $11.25/social-set add-on). A customer needing 3 more brands buys 3 add-ons.
--
-- No client-facing RLS policies, same fail-closed-by-omission pattern as
-- storage_addons/oauth_states/media_uploads — only the backend's
-- service-role client ever touches this table.
-- cancel_at_period_end included from day one (unlike storage_addons, which
-- only gained it later in migration 0043) -- same reasoning as that
-- migration: Paddle's own cancellation is deferred to next_billing_period,
-- so this tracks that locally while status stays active until the real
-- subscription.canceled webhook lands.
create table brand_addons (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  mor_subscription_id text not null unique,
  status text not null check (status in ('trialing', 'active', 'past_due', 'cancelled')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index brand_addons_account_id_idx on brand_addons (account_id);

alter table brand_addons enable row level security;
