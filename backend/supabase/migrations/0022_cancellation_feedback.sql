-- Captures optional free-text feedback a customer leaves in the "before you
-- cancel" modal — same pattern competitors (Blotato, etc.) use to learn why
-- people leave, instead of just letting the subscription silently lapse.
create table cancellation_feedback (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  tier text not null,
  feedback text,
  created_at timestamptz not null default now()
);

alter table cancellation_feedback enable row level security;

-- No select/insert policies for anon/authenticated — only the backend's
-- service-role client writes this, same as oauth_states/media_uploads.
