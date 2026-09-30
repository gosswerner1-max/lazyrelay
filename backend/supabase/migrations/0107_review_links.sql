-- Client review links (master list #23): a customer sends a link to a client, who
-- (without an account) sees the posts waiting for approval, approves them, asks for
-- changes, and comments. The link's token is the only credential, so it is long and
-- random, can expire, and can be revoked. RLS on, no policies: only the backend's
-- service-role key reads or writes these tables, always scoped by account_id.

create table if not exists review_links (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  token text not null unique,
  label text,
  brand_label text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_viewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists review_links_account_idx on review_links (account_id);

-- The conversation on a post: comments from the reviewer and from the owner, plus a
-- record of each decision (approved / changes requested) and who made it.
create table if not exists post_review_comments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  post_id uuid not null references scheduled_posts(id) on delete cascade,
  review_link_id uuid references review_links(id) on delete set null,
  author_kind text not null check (author_kind in ('reviewer', 'owner')),
  author_name text not null,
  kind text not null default 'comment' check (kind in ('comment', 'approved', 'changes_requested', 'updated')),
  body text,
  created_at timestamptz not null default now()
);
create index if not exists post_review_comments_post_idx on post_review_comments (post_id, created_at);
create index if not exists post_review_comments_link_idx on post_review_comments (review_link_id) where kind = 'approved';

-- Set when a reviewer asks for changes; cleared when the owner updates the post.
alter table scheduled_posts add column if not exists changes_requested_at timestamptz;

alter table review_links enable row level security;
alter table post_review_comments enable row level security;
