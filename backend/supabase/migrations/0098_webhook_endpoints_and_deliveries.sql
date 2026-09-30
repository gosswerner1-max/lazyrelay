-- Webhooks v2: several endpoints per account, event choices, a per-channel
-- filter, and durable delivery with retries.
--
-- Until now an account had ONE webhook (accounts.webhook_url/webhook_secret,
-- migration 0041), one event (post.verified) and a single fire-and-forget
-- attempt that was lost if the customer's endpoint was down at that instant.
--
-- webhook_endpoints: one row per receiving URL.
--   events              which events it wants; an EMPTY array means all events.
--   social_account_ids  restrict to these connected channels; NULL means all.
--   secret              plaintext on purpose (needed to sign every delivery, same
--                       reasoning as 0041). Locked down with RLS below.
-- webhook_deliveries: one row per (event, endpoint); the queue and the log.
--   status: pending (waiting for its next attempt), sending (claimed), delivered,
--   failed (gave up). attempts / next_attempt_at drive the retry schedule.
--
-- Both tables have RLS enabled and NO policies: only the backend's service-role
-- key can read them, so a customer's browser session can never read a secret.
--
-- The one existing webhook (an internal test endpoint) is copied over. The old
-- accounts.webhook_* columns are left in place, unused, so this can be rolled
-- back; a later migration can drop them.

create table if not exists webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  label text,
  url text not null,
  secret text not null,
  events text[] not null default '{}',
  social_account_ids uuid[],
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists webhook_endpoints_account_idx on webhook_endpoints (account_id);

create table if not exists webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references webhook_endpoints(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  event text not null,
  event_id uuid not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'delivered', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_status_code integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz
);

create index if not exists webhook_deliveries_due_idx on webhook_deliveries (status, next_attempt_at);
create index if not exists webhook_deliveries_endpoint_idx on webhook_deliveries (endpoint_id, created_at desc);
create index if not exists webhook_deliveries_account_idx on webhook_deliveries (account_id);

alter table webhook_endpoints enable row level security;
alter table webhook_deliveries enable row level security;

insert into webhook_endpoints (account_id, label, url, secret)
select id, 'Default', webhook_url, webhook_secret
  from accounts
 where webhook_url is not null
   and webhook_secret is not null
   and not exists (select 1 from webhook_endpoints e where e.account_id = accounts.id);
