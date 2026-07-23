-- Tracks purchased "extra storage" add-ons (2026-07-23) — sold on top of a
-- tier's base quota (Starter/Pro/Business only, not Free; see
-- storageQuota.ts and the pricing decision in memory). Each add-on is its
-- OWN Paddle subscription (not folded into the account's single tier
-- subscription row), because a customer can stack multiple add-ons, and
-- because "cancel this one add-on" must not touch the main tier
-- subscription. Upserted on mor_subscription_id, not account_id — unlike
-- `subscriptions`, one account can legitimately have several active rows
-- here at once.
--
-- No client-facing RLS policies, same fail-closed-by-omission pattern as
-- oauth_states/media_uploads — only the backend's service-role client ever
-- touches this table.
create table storage_addons (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  mor_subscription_id text not null unique,
  gb_amount integer not null,
  status text not null check (status in ('trialing', 'active', 'past_due', 'cancelled')),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table storage_addons enable row level security;
