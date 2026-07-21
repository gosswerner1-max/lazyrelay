-- Short-lived, one-time-use tokens that tie an OAuth callback back to the
-- specific account that started the connect flow. Without this, a forged
-- callback (or one platform account's code replayed) could get linked to
-- the wrong LazyRelay account. Table-backed rather than in-memory so it
-- survives a restart and works across multiple backend instances.

create table oauth_states (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  platform text not null check (platform in ('meta', 'tiktok', 'pinterest')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes')
);

alter table oauth_states enable row level security;
-- No policies granting select/insert/update/delete to anon/authenticated —
-- this table is only ever touched by the backend service (service_role),
-- never directly by a client. Fail-closed by omission.

grant all on oauth_states to service_role;

create index oauth_states_expiry_idx on oauth_states (expires_at);
