-- Master/admin API keys (2026-08-07) — a distinct key type from the
-- customer-facing api_keys table (0023). Not tied to any single
-- account_id, since the entire point is acting across every tenant
-- rather than one of them. Kept as its own table rather than a nullable
-- account_id on api_keys so a bug can never accidentally treat a scoped
-- customer key as an admin key or vice versa — auth.ts looks the two up
-- from entirely separate tables.
create table admin_api_keys (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  key_prefix text not null,
  key_hash text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index admin_api_keys_key_hash_idx on admin_api_keys (key_hash) where revoked_at is null;

alter table admin_api_keys enable row level security;

-- Every admin-key request gets logged here: which key, what it called, and
-- which customer account (if any) it acted on behalf of via the
-- X-Account-Id header. A key powerful enough to touch every account needs
-- a real trail, not just a shrug, if it's ever misused or leaked.
create table admin_audit_log (
  id uuid primary key default uuid_generate_v4(),
  admin_key_id uuid not null references admin_api_keys(id) on delete cascade,
  method text not null,
  path text not null,
  target_account_id uuid references accounts(id) on delete set null,
  created_at timestamptz not null default now()
);

create index admin_audit_log_admin_key_id_idx on admin_audit_log (admin_key_id);
create index admin_audit_log_created_at_idx on admin_audit_log (created_at);

alter table admin_audit_log enable row level security;
