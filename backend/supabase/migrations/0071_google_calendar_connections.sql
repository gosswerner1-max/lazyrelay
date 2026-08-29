-- Google Calendar two-way sync. Deliberately NOT modeled as a social_accounts
-- row / platforms-registry entry: PlatformAdapter's post()/verifyPublished()
-- are non-optional (see platforms/types.ts) because "post to a platform and
-- verify it went live" is what every existing adapter actually does. Calendar
-- doesn't post anything anywhere -- it's a two-way data source, a genuinely
-- different shape -- so it gets its own table and its own OAuth client
-- (backend/src/googleCalendar/), reusing only the generic Vault token
-- primitives (store_social_token/read_social_token/update_social_token,
-- migration 0001/0032) that were already written platform-agnostic.

create table google_calendar_connections (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  access_token_vault_id uuid not null references vault.secrets(id),
  refresh_token_vault_id uuid references vault.secrets(id),
  token_expires_at timestamptz,
  -- The id of the dedicated "LazyRelay Posts" calendar this connection
  -- created via calendars.insert at connect time -- NOT the customer's
  -- primary calendar. Every event in it unambiguously IS a scheduled post;
  -- nothing else ever gets written here or needs to be filtered out.
  google_calendar_id text not null,
  -- Calendar API incremental-sync token (events.list?syncToken=...). Null
  -- until the first full sync populates it; a 410 response from Google means
  -- the token expired/is invalid and the inbound poller must fall back to a
  -- full resync and store a fresh one.
  sync_token text,
  -- Which connected social accounts a calendar-created event defaults to
  -- when it wasn't originated from LazyRelay (a customer has no way to pick
  -- target platforms from inside Google Calendar's own UI) -- see
  -- needs_approval handling in inboundSyncPoller.ts.
  target_social_account_ids uuid[] not null default '{}',
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  last_synced_at timestamptz,
  -- One Google Calendar connection per LazyRelay account for V1 -- multiple
  -- connections (e.g. per-brand) is a real but explicitly deferred feature.
  unique (account_id)
);

alter table google_calendar_connections enable row level security;

create policy "google_calendar_connections_all_own" on google_calendar_connections
  for all using (auth.uid() = account_id) with check (auth.uid() = account_id);

-- Short-lived CSRF state for the connect flow, mirroring oauth_states'
-- shape (migration 0004) but kept as its own table rather than adding
-- 'google-calendar' to oauth_states.platform's check constraint -- that
-- constraint is about which social PLATFORM to post to, a different concept
-- this feature deliberately stays out of (see the file header above).
create table google_calendar_oauth_states (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes')
);

alter table google_calendar_oauth_states enable row level security;
-- No policies granting select/insert/update/delete to anon/authenticated --
-- only ever touched by the backend service (service_role), same
-- fail-closed-by-omission pattern as oauth_states.

grant all on google_calendar_oauth_states to service_role;

create index google_calendar_oauth_states_expiry_idx on google_calendar_oauth_states (expires_at);
