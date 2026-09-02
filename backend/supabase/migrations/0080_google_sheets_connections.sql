-- Google Sheets content-calendar export. A differentiator, not a customer
-- ask (see 03 - LazyRelay/project-google-sheets-sync-2026-09-02.md in the
-- vault) -- kept deliberately minimal: outbound-only (LazyRelay -> Sheets,
-- no inbound edit-detection the way Calendar has), one dedicated
-- LazyRelay-owned spreadsheet per account, never an existing sheet the
-- customer already has (drive.file only grants access to files this app
-- itself creates -- "load your own sheet" would need Google's Picker
-- widget, deliberately out of scope for v1).
--
-- Own table, own OAuth connection, independent of google_calendar_connections
-- -- a customer can use either feature without the other, same
-- separation-of-concerns reasoning as migration 0071's header comment for
-- why Calendar got its own table instead of reusing social_accounts.

create table google_sheets_connections (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  access_token_vault_id uuid not null references vault.secrets(id),
  refresh_token_vault_id uuid references vault.secrets(id),
  token_expires_at timestamptz,
  -- The id of the dedicated "LazyRelay Content Calendar" spreadsheet this
  -- connection created via spreadsheets.create at connect time. Every sync
  -- rewrites this sheet's data range in full from current scheduled_posts
  -- state (see outboundSync.ts) -- no per-row id tracking needed, so unlike
  -- google_calendar_connections there's no sync_token here either.
  spreadsheet_id text not null,
  connected_email text,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  last_synced_at timestamptz,
  -- One Google Sheets connection per LazyRelay account for V1, same as
  -- Calendar's own v1 scoping.
  unique (account_id)
);

alter table google_sheets_connections enable row level security;

create policy "google_sheets_connections_all_own" on google_sheets_connections
  for all using (auth.uid() = account_id) with check (auth.uid() = account_id);

-- Short-lived CSRF state for the connect flow -- same shape as
-- google_calendar_oauth_states (migration 0071), kept as its own table for
-- the same reason: this isn't a social-platform connection.
create table google_sheets_oauth_states (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes')
);

alter table google_sheets_oauth_states enable row level security;
-- No policies granting select/insert/update/delete to anon/authenticated --
-- only ever touched by the backend service (service_role), same
-- fail-closed-by-omission pattern as oauth_states / google_calendar_oauth_states.

grant all on google_sheets_oauth_states to service_role;

create index google_sheets_oauth_states_expiry_idx on google_sheets_oauth_states (expires_at);
