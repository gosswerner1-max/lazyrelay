-- Captures real, server-measured metadata for each uploaded media file at
-- upload time (size, mime type, and — for images — pixel dimensions). This
-- is what lets /scheduled-posts validate a file against the TARGET
-- platform's real requirements using metadata we measured ourselves,
-- rather than trusting whatever the browser claims about a file it already
-- uploaded minutes earlier. See mediaLimits.ts for the actual per-platform
-- rules.
--
-- No client-facing RLS policies, same fail-closed-by-omission pattern as
-- 0004_oauth_states.sql — only the backend's service-role client ever
-- reads/writes this table.
create table media_uploads (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  url text not null unique,
  mime_type text not null,
  size_bytes integer not null,
  width integer,
  height integer,
  created_at timestamptz not null default now()
);

alter table media_uploads enable row level security;
