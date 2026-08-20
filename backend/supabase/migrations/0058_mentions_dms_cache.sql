-- Cached mentions/DMs, refreshed by a periodic poller (mentionsAndDmsPoller.ts)
-- instead of fetched live from each platform on every tab view. This is what
-- makes a notification bell possible without hitting live platform APIs on
-- every page load, and also removes the live-call-per-pageview cost from the
-- Mentions/DMs tabs themselves once GET /mentions and GET /dms are switched
-- to read from these tables. See werner-brain 2026-08-20 daily note.
--
-- No client-facing RLS policies, same fail-closed-by-omission pattern as
-- 0004_oauth_states.sql / 0009_media_uploads.sql — only the backend's
-- service-role client (the API routes and the poller) ever reads/writes
-- these tables.
create table mention_comments_cache (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  scheduled_post_id uuid not null references scheduled_posts(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  platform_comment_id text not null,
  author text not null,
  text text not null,
  url text,
  -- The platform's own comment timestamp, when it supplies one — not every
  -- adapter's getComments() returns this (CommentItem.createdAt is
  -- nullable), so the notification-summary query falls back to
  -- first_seen_at for those. first_seen_at is set once at insert and never
  -- touched again by the poller's upsert (deliberately excluded from its
  -- ON CONFLICT update columns) — it's "when WE first discovered this
  -- comment exists," independent of whatever the platform's clock says.
  comment_created_at timestamptz,
  first_seen_at timestamptz not null default now(),
  fetched_at timestamptz not null default now(),
  unique (scheduled_post_id, platform_comment_id)
);
create index mention_comments_cache_account_idx on mention_comments_cache (account_id);

-- A conversation ROW is long-lived (the same conversation_id accumulates
-- many messages over time), unlike a comment which never changes once
-- posted — so conversation_updated_at is deliberately overwritten on every
-- poll with the platform's latest value (never protected from update, the
-- opposite of mention_comments_cache.first_seen_at above). That's what lets
-- a new message in an ALREADY-seen conversation still register as "new".
-- first_seen_at is kept as a fallback for the rare case a platform's
-- adapter doesn't supply updatedAt at all.
create table dm_conversations_cache (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  conversation_id text not null,
  participant_id text not null,
  participant_name text not null,
  snippet text,
  conversation_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  fetched_at timestamptz not null default now(),
  unique (social_account_id, conversation_id)
);
create index dm_conversations_cache_account_idx on dm_conversations_cache (account_id);

-- One row per LazyRelay account, tracking when the customer last actually
-- loaded each tab (bumped by GET /mentions and GET /dms themselves, not a
-- separate "mark as read" call) — what the notification-summary endpoint
-- compares the two cache tables' timestamps against. Defaults to the epoch
-- so an account that's never viewed either tab shows every cached item as
-- new, which is the correct behavior for a brand-new customer.
create table notification_view_state (
  account_id uuid primary key references accounts(id) on delete cascade,
  mentions_last_viewed_at timestamptz not null default '1970-01-01T00:00:00Z',
  dms_last_viewed_at timestamptz not null default '1970-01-01T00:00:00Z'
);

alter table mention_comments_cache enable row level security;
alter table dm_conversations_cache enable row level security;
alter table notification_view_state enable row level security;
