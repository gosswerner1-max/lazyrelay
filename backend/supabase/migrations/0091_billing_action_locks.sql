-- SECURITY FIX (2026-09-25): the five double-purchase concurrency guards in
-- routes.ts (checkout, change-tier, storage-addon/brand-addon/seat-addon
-- checkout) all shared one in-memory `pendingTierChanges` Set. That Set only
-- ever protected a single Node process -- Render's zero-downtime deploys
-- briefly run the old and new process side by side, each with its own
-- independent, empty Set, during which the exact double-purchase race these
-- locks exist to close (see routes.ts's own long comment above that Set,
-- 2026-09-01/2026-09-14) reopens with no warning. Supabase is the one store
-- every process already shares, so a short-lived row here (one per account,
-- covering all five actions -- same "this account has an in-flight
-- subscription-lifecycle mutation" semantic the old shared Set already used)
-- replaces the in-memory Set. expires_at makes a lock self-healing if a
-- process ever crashes mid-request without reaching its `finally` release --
-- see backend/src/billing/locks.ts for the acquire/release logic built on
-- this table.
create table if not exists billing_action_locks (
  account_id uuid primary key references accounts(id) on delete cascade,
  action text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table billing_action_locks is 'Short-lived cross-process lock for one in-flight billing mutation per account (checkout/tier-change/add-on purchase). Service-role only -- see backend/src/billing/locks.ts. Rows are transient (TTL ~seconds); this table is never a source of truth the way subscriptions/*_addons are.';

-- No client-facing RLS policies -- same convention as storage_addons/
-- brand_addons/seat_addons (0012_storage_addons.sql etc.): only the
-- backend's service-role client ever touches this table.
alter table billing_action_locks enable row level security;

-- Cheap cleanup path for a stray expired row that was never stolen or
-- deleted (e.g. the account never made another billing request) -- not
-- required for correctness (acquireBillingLock already treats an expired
-- row as free and steals it atomically), just keeps the table from
-- accumulating dead rows indefinitely.
create index if not exists billing_action_locks_expires_at_idx on billing_action_locks (expires_at);
