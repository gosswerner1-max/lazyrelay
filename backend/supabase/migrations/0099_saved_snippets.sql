-- Saved snippets: reusable pieces of text (a hashtag group, a call-to-action
-- footer, a disclaimer) a customer inserts into a post from the composer.
-- One snippet per account can be marked as the account's signature (a quick
-- "add my signature" button). The text is inserted into the post box where the
-- customer can see and change it; nothing is appended silently on the server.
--
-- RLS enabled with no policies: only the backend's service-role key reads or
-- writes it, always filtered by account_id in the routes (same approach as
-- webhook_endpoints, 0098).

create table if not exists saved_snippets (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  name text not null,
  content text not null,
  is_signature boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists saved_snippets_account_idx on saved_snippets (account_id, created_at);

alter table saved_snippets enable row level security;
