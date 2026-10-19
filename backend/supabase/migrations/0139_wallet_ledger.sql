-- 0139: wallet ledger (service credits) for metered actions.
--
-- Applied to production by hand on 2026-10-19 with the owner's go. The wallet stays OFF (WALLET_ENABLED unset): nothing charges or pauses anyone.
-- Behaviour was checked on PGlite (47 checks, backend/scripts/wallet-sql-check.mjs), then on the production database by the checks listed in the PR.
--
-- What this is. A prepaid balance per account, and an append only ledger of every change to it. Two metered actions have a price in the
-- wallet_prices table: api_dispatch (a verified platform API dispatch) and sitemap_sync (a sitemap crawl and sync of a Content Sources
-- source). Money is stored as whole micro dollars (1 USD = 1,000,000), so 0.002 USD is 2,000 and 0.05 USD is 50,000. No floating point.
--
-- Rules the database itself enforces (not the application):
--   1. The balance can never go below zero (check constraint plus a locked read before every change).
--   2. A charge is never given an amount by the caller: the caller names an ACTION and a unit count, and the price comes from
--      wallet_prices. A negative or arbitrary cost is therefore impossible. A credit must be strictly positive.
--   3. Every change is one ledger row with the balance after it. The ledger cannot be updated, deleted or truncated (triggers).
--   4. Every change carries an idempotency key, unique per account: a repeated key returns the first result and changes nothing, so a
--      retried webhook or a retried dispatch never charges or credits twice.
--   5. Only the backend's service role can run the functions. The browser roles can read their own account's rows (members only) and
--      can write nothing. The service role itself has SELECT only on the tables, so even a bug in the backend cannot edit a balance
--      without going through the functions.
--
-- What it does not do: it does not charge anything by itself. Nothing in the backend calls these functions until the wallet is
-- switched on (WALLET_ENABLED=true) and wired in; see the wallet design notes (kept outside this repository).
--
-- Idempotent (safe to apply twice) and wrapped in one transaction.
--
-- ROLLBACK (by hand; it deletes all wallet history):
--   drop function if exists public.wallet_grandfather_accounts(timestamptz);
--   drop function if exists public.wallet_paused_account_ids(bigint);
--   drop function if exists public.wallet_charge(uuid, text, integer, text);
--   drop function if exists public.wallet_credit(uuid, bigint, text, text, text);
--   drop table if exists public.wallet_ledger;
--   drop table if exists public.wallet_legacy_accounts;
--   drop table if exists public.wallet_accounts;
--   drop table if exists public.wallet_prices;
--   drop function if exists public.wallet_ledger_append_only();

begin;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Prices. Changing a price is a migration or an owner run statement, never a request parameter.
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.wallet_prices (
  action_type text primary key check (action_type in ('api_dispatch', 'sitemap_sync')),
  price_micro bigint not null check (price_micro > 0),
  updated_at timestamptz not null default now()
);

insert into public.wallet_prices (action_type, price_micro)
values ('api_dispatch', 2000), ('sitemap_sync', 50000)
on conflict (action_type) do nothing;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Balance per account.
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.wallet_accounts (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  balance_micro bigint not null default 0 check (balance_micro >= 0),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------------------------------------
-- Grandfathered accounts (owner decision 2026-10-19). Every account that exists when the two tier model launches keeps its price and
-- limits and is NEVER metered or paused by the wallet. The wallet applies to accounts created on or after the cutoff. The list is a
-- snapshot taken by wallet_grandfather_accounts(cutoff), run once by hand on launch day.
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.wallet_legacy_accounts (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  grandfathered_at timestamptz not null default now(),
  cutoff timestamptz not null
);

-- ---------------------------------------------------------------------------------------------------------------------------
-- The ledger. No foreign key on purpose: the history of a deleted account must survive for bookkeeping.
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.wallet_ledger (
  id bigint generated always as identity primary key,
  account_id uuid not null,
  kind text not null check (kind in ('top_up', 'charge', 'refund', 'grant')),
  action_type text check (action_type in ('api_dispatch', 'sitemap_sync')),
  units integer check (units > 0),
  delta_micro bigint not null check (delta_micro <> 0),
  balance_after_micro bigint not null check (balance_after_micro >= 0),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  reference text check (reference is null or char_length(reference) <= 200),
  created_at timestamptz not null default now(),
  constraint wallet_ledger_sign check (
    (kind = 'charge' and delta_micro < 0 and action_type is not null and units is not null)
    or (kind in ('top_up', 'refund', 'grant') and delta_micro > 0 and action_type is null and units is null)
  ),
  constraint wallet_ledger_key unique (account_id, idempotency_key)
);

create index if not exists wallet_ledger_account_created_idx on public.wallet_ledger (account_id, created_at desc);

create or replace function public.wallet_ledger_append_only() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'wallet_ledger is append only' using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists wallet_ledger_no_update_delete on public.wallet_ledger;
create trigger wallet_ledger_no_update_delete before update or delete on public.wallet_ledger
  for each row execute function public.wallet_ledger_append_only();

drop trigger if exists wallet_ledger_no_truncate on public.wallet_ledger;
create trigger wallet_ledger_no_truncate before truncate on public.wallet_ledger
  for each statement execute function public.wallet_ledger_append_only();

-- ---------------------------------------------------------------------------------------------------------------------------
-- Charge: the caller names an action and a unit count; the price comes from wallet_prices.
-- Returns jsonb: {ok, replay, charged_micro, balance_micro} or {ok:false, reason:'insufficient_funds', balance_micro, required_micro}.
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function public.wallet_charge(p_account_id uuid, p_action text, p_units integer, p_key text) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_price bigint;
  v_cost bigint;
  v_balance bigint;
  v_existing public.wallet_ledger%rowtype;
begin
  if p_account_id is null then raise exception 'wallet_charge: account is required' using errcode = 'invalid_parameter_value'; end if;
  if p_units is null or p_units < 1 or p_units > 10000 then raise exception 'wallet_charge: units must be from 1 to 10000' using errcode = 'invalid_parameter_value'; end if;
  if p_key is null or char_length(p_key) < 1 or char_length(p_key) > 128 then raise exception 'wallet_charge: a key of 1 to 128 characters is required' using errcode = 'invalid_parameter_value'; end if;

  select price_micro into v_price from public.wallet_prices where action_type = p_action;
  if v_price is null then raise exception 'wallet_charge: unknown action' using errcode = 'invalid_parameter_value'; end if;
  v_cost := v_price * p_units;

  -- A grandfathered account is never charged: no wallet row is created and no ledger row is written.
  if exists (select 1 from public.wallet_legacy_accounts where account_id = p_account_id) then
    return jsonb_build_object('ok', true, 'replay', false, 'exempt', true, 'charged_micro', 0,
      'balance_micro', coalesce((select balance_micro from public.wallet_accounts where account_id = p_account_id), 0));
  end if;

  insert into public.wallet_accounts (account_id) values (p_account_id) on conflict (account_id) do nothing;
  -- One lock per account: every change to this balance takes turns here, so the checks below cannot race.
  select balance_micro into v_balance from public.wallet_accounts where account_id = p_account_id for update;

  select * into v_existing from public.wallet_ledger where account_id = p_account_id and idempotency_key = p_key;
  if found then
    if v_existing.kind <> 'charge' or v_existing.action_type <> p_action or v_existing.units <> p_units then
      raise exception 'wallet_charge: this key was already used for a different change' using errcode = 'unique_violation';
    end if;
    return jsonb_build_object('ok', true, 'replay', true, 'charged_micro', -v_existing.delta_micro, 'balance_micro', v_balance);
  end if;

  if v_balance < v_cost then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_funds', 'balance_micro', v_balance, 'required_micro', v_cost);
  end if;

  update public.wallet_accounts set balance_micro = balance_micro - v_cost, updated_at = now() where account_id = p_account_id;
  insert into public.wallet_ledger (account_id, kind, action_type, units, delta_micro, balance_after_micro, idempotency_key)
  values (p_account_id, 'charge', p_action, p_units, -v_cost, v_balance - v_cost, p_key);

  return jsonb_build_object('ok', true, 'replay', false, 'charged_micro', v_cost, 'balance_micro', v_balance - v_cost);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Credit: strictly positive, at most 1,000,000 USD in one go. kind is top_up (a paid top up) or refund.
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function public.wallet_credit(p_account_id uuid, p_amount_micro bigint, p_key text, p_reference text default null, p_kind text default 'top_up') returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance bigint;
  v_existing public.wallet_ledger%rowtype;
begin
  if p_account_id is null then raise exception 'wallet_credit: account is required' using errcode = 'invalid_parameter_value'; end if;
  if p_amount_micro is null or p_amount_micro <= 0 then raise exception 'wallet_credit: the amount must be strictly positive' using errcode = 'invalid_parameter_value'; end if;
  if p_amount_micro > 1000000000000 then raise exception 'wallet_credit: the amount is above the limit' using errcode = 'invalid_parameter_value'; end if;
  if p_kind is null or p_kind not in ('top_up', 'refund', 'grant') then raise exception 'wallet_credit: kind must be top_up, refund or grant' using errcode = 'invalid_parameter_value'; end if;
  if p_key is null or char_length(p_key) < 1 or char_length(p_key) > 128 then raise exception 'wallet_credit: a key of 1 to 128 characters is required' using errcode = 'invalid_parameter_value'; end if;

  insert into public.wallet_accounts (account_id) values (p_account_id) on conflict (account_id) do nothing;
  select balance_micro into v_balance from public.wallet_accounts where account_id = p_account_id for update;

  select * into v_existing from public.wallet_ledger where account_id = p_account_id and idempotency_key = p_key;
  if found then
    if v_existing.kind <> p_kind or v_existing.delta_micro <> p_amount_micro then
      raise exception 'wallet_credit: this key was already used for a different change' using errcode = 'unique_violation';
    end if;
    return jsonb_build_object('ok', true, 'replay', true, 'credited_micro', v_existing.delta_micro, 'balance_micro', v_balance);
  end if;

  update public.wallet_accounts set balance_micro = balance_micro + p_amount_micro, updated_at = now() where account_id = p_account_id;
  insert into public.wallet_ledger (account_id, kind, delta_micro, balance_after_micro, idempotency_key, reference)
  values (p_account_id, p_kind, p_amount_micro, v_balance + p_amount_micro, p_key, p_reference);

  return jsonb_build_object('ok', true, 'replay', false, 'credited_micro', p_amount_micro, 'balance_micro', v_balance + p_amount_micro);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Access. RLS on, members read their own account's rows, nobody in the browser writes. The service role gets SELECT only on the
-- tables; its writes go through the two functions above.
-- ---------------------------------------------------------------------------------------------------------------------------
alter table public.wallet_prices enable row level security;
alter table public.wallet_accounts enable row level security;
alter table public.wallet_ledger enable row level security;
alter table public.wallet_legacy_accounts enable row level security;

drop policy if exists wallet_prices_select_all on public.wallet_prices;
create policy wallet_prices_select_all on public.wallet_prices for select to authenticated using (true);
drop policy if exists wallet_accounts_select_members on public.wallet_accounts;
create policy wallet_accounts_select_members on public.wallet_accounts for select to authenticated using (is_account_member(account_id));
drop policy if exists wallet_ledger_select_members on public.wallet_ledger;
create policy wallet_ledger_select_members on public.wallet_ledger for select to authenticated using (is_account_member(account_id));

revoke all on public.wallet_prices, public.wallet_accounts, public.wallet_ledger, public.wallet_legacy_accounts from public, anon, authenticated, service_role;
grant select on public.wallet_legacy_accounts to service_role;
grant select on public.wallet_prices, public.wallet_accounts, public.wallet_ledger to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Paused accounts: those WITH a wallet whose balance cannot pay for the cheapest action (p_min micro dollars). An account with no
-- wallet row is not listed: it was never given a balance, and listing it would stop its queue the moment the wallet is switched on.
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function public.wallet_paused_account_ids(p_min bigint default 2000) returns setof uuid
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if p_min is null or p_min < 1 then raise exception 'wallet_paused_account_ids: p_min must be above zero' using errcode = 'invalid_parameter_value'; end if;
  -- Grandfathered accounts are never paused, whatever their balance.
  return query
    select w.account_id from public.wallet_accounts w
    where w.balance_micro < p_min and not exists (select 1 from public.wallet_legacy_accounts l where l.account_id = w.account_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- The one time snapshot. Marks every account created BEFORE the cutoff as grandfathered. Safe to run twice (it adds nobody new).
-- The cutoff cannot be in the future: that would exempt accounts that have not signed up yet. Returns how many were added.
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function public.wallet_grandfather_accounts(p_cutoff timestamptz) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_added integer;
begin
  if p_cutoff is null then raise exception 'wallet_grandfather_accounts: a cutoff is required' using errcode = 'invalid_parameter_value'; end if;
  if p_cutoff > now() then raise exception 'wallet_grandfather_accounts: the cutoff cannot be in the future' using errcode = 'invalid_parameter_value'; end if;
  insert into public.wallet_legacy_accounts (account_id, cutoff)
  select a.id, p_cutoff from public.accounts a where a.created_at < p_cutoff
  on conflict (account_id) do nothing;
  get diagnostics v_added = row_count;
  return v_added;
end;
$$;

revoke all on function public.wallet_grandfather_accounts(timestamptz) from public, anon, authenticated;
grant execute on function public.wallet_grandfather_accounts(timestamptz) to service_role;

revoke all on function public.wallet_paused_account_ids(bigint) from public, anon, authenticated;
grant execute on function public.wallet_paused_account_ids(bigint) to service_role;

revoke all on function public.wallet_charge(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.wallet_credit(uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.wallet_charge(uuid, text, integer, text) to service_role;
grant execute on function public.wallet_credit(uuid, bigint, text, text, text) to service_role;

commit;
