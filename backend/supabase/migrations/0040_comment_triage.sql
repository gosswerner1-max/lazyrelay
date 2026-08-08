-- Comment/DM triage (2026-08-08) — item 10 from the 2026-08-07 competitor
-- audit's "my own ideas" list: rather than a full unified inbox, surface
-- only the comment/DM that actually needs a human ("angry customer",
-- "sales question"), on top of the Mentions/DMs inbox shipped 2026-08-07.
--
-- Comments and DMs themselves are never persisted (fetched live from each
-- platform per request) — this table only caches the AI classification, so
-- the same comment/conversation isn't re-sent to Anthropic on every tab
-- load. item_id is the platform comment id for a comment, or the
-- conversation id for a DM. source_signature is what's compared to decide
-- whether a cached row is stale: for a comment it's just item_id again
-- (comment text never changes after posting); for a DM conversation it's
-- the conversation's updatedAt, so a new incoming message naturally
-- invalidates the cached classification and gets re-triaged.
create table comment_triage (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  item_type text not null check (item_type in ('comment', 'dm')),
  item_id text not null,
  source_signature text not null,
  needs_attention boolean not null,
  category text not null,
  reason text not null,
  classified_at timestamptz not null default now(),
  unique (account_id, item_type, item_id)
);

create index comment_triage_account_id_idx on comment_triage (account_id);

alter table comment_triage enable row level security;
