-- Real brand entities (2026-08-16) — promotes the free-text brand_label
-- (migration 0042) to a first-class row so brands can be COUNTED and CAPPED
-- per tier. This closes the pricing leak where unlimited brands on any plan
-- let one login run an agency's worth of client businesses for a flat fee.
--
-- Still one login / one subscription — NOT multi-tenant workspaces with
-- separate billing. A "brand" groups connected accounts by business for
-- filtering, exactly as brand_label did, but is now enforceable against a
-- per-tier cap (brandLimits.ts: Free 1 / Starter 2 / Pro 4 / Business 7) and
-- later meterable for a per-brand overage.
--
-- brand_label is intentionally LEFT in place for now as a transition safety
-- net; it is dropped in a later cleanup migration once brand_id is fully wired
-- through the app and verified.

create table brands (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create index brands_account_id_idx on brands (account_id);

-- No duplicate brand names within one account, case-insensitive so
-- "Brand A" and "brand a" can't split into two brands (which would also
-- fragment the brand filter and inflate the counted total against the cap).
create unique index brands_account_id_lower_name_idx on brands (account_id, lower(name));

alter table brands enable row level security;

-- Link a connected account to its brand. Nullable: an account is "unbranded"
-- until assigned. on delete set null so removing a brand un-brands its
-- accounts rather than deleting the accounts themselves.
alter table social_accounts add column brand_id uuid references brands(id) on delete set null;

create index social_accounts_brand_id_idx on social_accounts (brand_id);

-- Backfill: turn existing distinct brand labels into brand rows, then point
-- each labeled account at its new brand. distinct on (account_id, lower(label))
-- dedupes case-insensitively so no row violates the unique index above.
-- This is a no-op on current data (every brand_label is empty) but is written
-- to be correct if any labels exist now or on replay.
insert into brands (account_id, name)
select distinct on (account_id, lower(trim(brand_label)))
       account_id, trim(brand_label)
from social_accounts
where brand_label is not null and trim(brand_label) <> ''
order by account_id, lower(trim(brand_label)), id;

update social_accounts sa
set brand_id = b.id
from brands b
where sa.brand_label is not null
  and trim(sa.brand_label) <> ''
  and b.account_id = sa.account_id
  and lower(b.name) = lower(trim(sa.brand_label));
