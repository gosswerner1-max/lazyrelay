-- LazyRelay core schema
-- Every table has RLS enabled from creation — no table ships open by default.
-- OAuth tokens are stored via Supabase Vault (encrypted), never as plaintext columns.

create extension if not exists "uuid-ossp";
create extension if not exists supabase_vault;

-- One row per LazyRelay customer, 1:1 with auth.users
create table accounts (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz
);

alter table accounts enable row level security;

create policy "accounts_select_own" on accounts
  for select using (auth.uid() = id);

create policy "accounts_update_own" on accounts
  for update using (auth.uid() = id);

-- Billing state, kept in sync from Merchant-of-Record webhooks (Paddle/Lemon Squeezy).
-- This table is never written to directly by the app — only by the webhook handler
-- running with the service role, so RLS here only needs to allow reads.
create table subscriptions (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  tier text not null check (tier in ('solo', 'pro', 'agency')),
  status text not null check (status in ('trialing', 'active', 'past_due', 'cancelled')),
  mor_subscription_id text not null unique,
  current_period_end timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table subscriptions enable row level security;

create policy "subscriptions_select_own" on subscriptions
  for select using (auth.uid() = account_id);

-- Connected social platform accounts. Access/refresh tokens are stored as
-- Vault secret references (uuid pointing into vault.secrets), never plaintext
-- columns on this table — see store_social_token()/read_social_token() below.
create table social_accounts (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  platform text not null check (platform in ('meta', 'tiktok', 'pinterest')),
  platform_account_id text not null,
  display_name text,
  access_token_vault_id uuid not null references vault.secrets(id),
  refresh_token_vault_id uuid references vault.secrets(id),
  token_expires_at timestamptz,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  unique (account_id, platform, platform_account_id)
);

alter table social_accounts enable row level security;

create policy "social_accounts_select_own" on social_accounts
  for select using (auth.uid() = account_id);

create policy "social_accounts_insert_own" on social_accounts
  for insert with check (auth.uid() = account_id);

create policy "social_accounts_delete_own" on social_accounts
  for delete using (auth.uid() = account_id);

-- Scheduled posts — the queue the scheduling engine drains.
create table scheduled_posts (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  content text not null,
  media_url text,
  scheduled_for timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'posting', 'posted', 'failed')),
  created_at timestamptz not null default now()
);

alter table scheduled_posts enable row level security;

create policy "scheduled_posts_select_own" on scheduled_posts
  for select using (auth.uid() = account_id);

create policy "scheduled_posts_insert_own" on scheduled_posts
  for insert with check (auth.uid() = account_id);

create policy "scheduled_posts_delete_own" on scheduled_posts
  for delete using (auth.uid() = account_id and status = 'pending');

create index scheduled_posts_pending_idx on scheduled_posts (scheduled_for)
  where status = 'pending';

-- Proof-of-Publish verification results. This is the core differentiator —
-- a real read-back check that the platform's API confirms the post is live,
-- not just that our own post call returned success.
create table post_results (
  id uuid primary key default uuid_generate_v4(),
  scheduled_post_id uuid not null references scheduled_posts(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  platform_post_id text,
  platform_post_url text,
  verified_live boolean not null default false,
  verification_checked_at timestamptz,
  error_message text,
  created_at timestamptz not null default now()
);

alter table post_results enable row level security;

create policy "post_results_select_own" on post_results
  for select using (auth.uid() = account_id);

-- Helper functions for storing/reading OAuth tokens via Vault — application
-- code should call these instead of ever touching vault.secrets directly.
create or replace function store_social_token(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_id uuid;
begin
  select vault.create_secret(p_token) into v_id;
  return v_id;
end;
$$;

create or replace function read_social_token(p_vault_id uuid)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where id = p_vault_id;
  return v_secret;
end;
$$;

-- Neither function is exposed to the anon/authenticated roles directly —
-- only the backend service (using the service role) calls these, per the
-- least-privilege principle from the security research.
revoke execute on function store_social_token(text) from anon, authenticated;
revoke execute on function read_social_token(uuid) from anon, authenticated;
