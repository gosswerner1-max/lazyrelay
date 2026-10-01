-- Adds Whop (whop.com) as a valid platform value, plus the two tables its connect step needs. Same pattern as
-- 0111_slack_platform.sql and 0113_nostr_platform.sql: the platform stays hidden from customers until WHOP_APP_API_KEY,
-- WHOP_APP_ID and a release switch (WHOP_PLATFORM_PUBLIC or WHOP_TEST_ACCOUNT_IDS) are set. Not applied by the author.
--
-- Whop has no per-customer secret: LazyRelay has ONE Whop app and ONE API key (environment), which works in every
-- community that installed the app. So a customer must prove they own a community before connecting it, and a
-- community can belong to only one LazyRelay account at a time. These two tables hold exactly that.

alter table oauth_states drop constraint oauth_states_platform_check;
alter table oauth_states add constraint oauth_states_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube', 'mastodon', 'bluesky', 'telegram', 'linkedin', 'threads', 'facebook', 'instagram', 'discord', 'tumblr', 'x', 'wordpress', 'devto', 'hashnode', 'lemmy', 'slack', 'nostr', 'whop'));

alter table social_accounts drop constraint social_accounts_platform_check;
alter table social_accounts add constraint social_accounts_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube', 'mastodon', 'bluesky', 'telegram', 'linkedin', 'threads', 'facebook', 'instagram', 'discord', 'tumblr', 'x', 'wordpress', 'devto', 'hashnode', 'lemmy', 'slack', 'nostr', 'whop'));

-- One-time ownership challenges. The customer posts the code in a forum of the community as an admin; LazyRelay reads it
-- back. Only a SHA-256 of the code is kept. A code is bound to one LazyRelay account and one community, lasts 15 minutes,
-- and works once (used_at is set by a single conditional update, so a replay finds it already set).
create table whop_connect_challenges (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  company_id text not null check (company_id ~ '^biz_[A-Za-z0-9]{4,40}$'),
  code_hash text not null,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  used_at timestamptz
);

alter table whop_connect_challenges enable row level security;
-- No policies for anon/authenticated: only the backend (service_role) touches this table, same as oauth_states.
grant all on whop_connect_challenges to service_role;

create index whop_connect_challenges_account_idx on whop_connect_challenges (account_id, created_at);
create index whop_connect_challenges_expiry_idx on whop_connect_challenges (expires_at);

-- One community, one LazyRelay account. The primary key makes two simultaneous claims race safely (the loser's insert
-- fails). A claim whose holder has disconnected every forum of the community is stale and can be taken over by an
-- account that has just proved ownership (platforms/whopConnect.ts, claimWhopCompany).
create table whop_company_claims (
  company_id text primary key check (company_id ~ '^biz_[A-Za-z0-9]{4,40}$'),
  account_id uuid not null references accounts(id) on delete cascade,
  claimed_at timestamptz not null default now()
);

alter table whop_company_claims enable row level security;
-- No policies: service_role only, fail-closed by omission.
grant all on whop_company_claims to service_role;

create index whop_company_claims_account_idx on whop_company_claims (account_id);
