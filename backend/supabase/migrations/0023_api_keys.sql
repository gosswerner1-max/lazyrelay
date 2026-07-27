create table api_keys (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  name text not null,
  key_prefix text not null,
  key_hash text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index api_keys_key_hash_idx on api_keys (key_hash) where revoked_at is null;
create index api_keys_account_id_idx on api_keys (account_id);

alter table api_keys enable row level security;
