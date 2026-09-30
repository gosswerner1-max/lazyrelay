-- Mastodon on a customer's own instance (master list #11).
--
-- Mastodon is decentralised: every instance is its own OAuth server and needs its own app
-- registration (POST /api/v1/apps, instant, no review). LazyRelay registers on the first use of an
-- instance and keeps the result here so a restart or a second backend instance does not register again.
--
-- oauth_states.context carries the customer's chosen instance (an https origin such as
-- https://hachyderm.io) from the start of a connect to the code exchange. It is a plain nullable
-- column and leaves pkce_verifier alone. It is removed with the row when the flow expires.
alter table oauth_states add column context text;

-- One row per instance origin. The client secret is NOT stored here in plain text: it lives in
-- Vault (same store_social_token / read_social_token helpers as every platform token) and this row
-- only holds the Vault id.
create table mastodon_apps (
  instance text primary key,
  client_id text not null,
  client_secret_vault_id uuid not null references vault.secrets(id),
  redirect_uri text not null,
  created_at timestamptz not null default now()
);

alter table mastodon_apps enable row level security;
-- No policies for anon/authenticated: only the backend (service_role) ever touches this table.
-- Fail-closed by omission, same as oauth_states.
grant all on mastodon_apps to service_role;

-- Index on the foreign key (same reason as 0089: deletes on vault.secrets and joins stay cheap).
create index mastodon_apps_client_secret_vault_id_idx on mastodon_apps (client_secret_vault_id);

-- Abuse cap: one LazyRelay account may start connects to at most a few different Mastodon servers per
-- day (mastodonInstanceLimit.ts). One row per account and server, refreshed on use, cleared after a day.
create table mastodon_instance_attempts (
  account_id uuid not null references accounts(id) on delete cascade,
  instance text not null,
  created_at timestamptz not null default now(),
  primary key (account_id, instance)
);

alter table mastodon_instance_attempts enable row level security;
-- No policies: service_role only, same as mastodon_apps and oauth_states.
grant all on mastodon_instance_attempts to service_role;
