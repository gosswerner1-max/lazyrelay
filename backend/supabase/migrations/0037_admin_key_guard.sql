-- Admin-key request guard (2026-08-08) — closes the gap where a leaked
-- lzr_admin_ key could be used immediately, silently, and forever. No
-- expiry date can catch active misuse (a stolen key gets used right away,
-- not after it sits dormant) — see project-media-security-hardening-
-- 2026-07-24.md in the vault for the full reasoning that led here.
--
-- Two lanes for a valid admin key to actually be USED (being a valid,
-- non-revoked key is no longer enough on its own):
--   1. Known recurring jobs — pre-registered here by name, allowed to use
--      the key on their own schedule without a fresh announcement each run.
--   2. Everything else — must be freshly "announced" by a real human
--      Supabase session first (never by the admin key itself, so a leaked
--      key alone can never self-announce). See POST /admin/announce.
-- Anything matching neither lane gets the key auto-revoked immediately
-- and the reason recorded in admin_api_keys.revoked_reason.
--
-- *** IMPORTANT — READ BEFORE CHANGING ANY LAZYRELAY SCHEDULED TASK ***
-- If a scheduled/cron job's NAME changes, or a new job starts using the
-- admin key, or a job's cadence changes in a way that affects how it
-- authenticates, admin_key_registered_jobs must be updated in the SAME
-- change. Otherwise that job's admin-key calls start failing with a 403
-- and no obvious cause beyond "unannounced admin action" rows in
-- admin_audit_log / admin_api_keys.revoked_reason — this exact scenario
-- is what LazyRelay_security note calls out as "sit here for hours
-- trying to find the problem." See backend/src/http/auth.ts's
-- authorizeAdminRequest() for where this is enforced.

create table admin_key_registered_jobs (
  job_name text primary key,
  description text not null,
  created_at timestamptz not null default now()
);

-- Deliberately empty at creation time — as of 2026-08-08, no LazyRelay
-- scheduled task actually uses the admin key yet (it was built 2026-08-07
-- ahead of real customer traffic, per Werner's "we'll use it as soon as
-- we get customers" call). Add a row here the day any scheduled task
-- starts relying on X-Account-Id + the admin key.

create table admin_key_intents (
  id uuid primary key default uuid_generate_v4(),
  -- Filled in at CONSUMPTION time, not announcement time — the human
  -- announcing doesn't need to know which physical key will use the
  -- window, only that they're opening a short window for the next use.
  admin_key_id uuid references admin_api_keys(id) on delete cascade,
  announced_by uuid not null,
  task_label text,
  announced_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index admin_key_intents_open_idx on admin_key_intents (expires_at) where consumed_at is null;

alter table admin_key_registered_jobs enable row level security;
alter table admin_key_intents enable row level security;

alter table admin_api_keys add column revoked_reason text;
