-- 0140: wallet credit lots (LazyCredits). Adds lots, holds, a pack catalog and the functions that spend them.
--
-- NOT applied anywhere yet. The wallet stays OFF (WALLET_ENABLED unset). Behaviour is checked on PGlite by
-- backend/scripts/wallet-lots-sql-check.mjs (with a mutation run: --mutations).
--
-- UNIT CHANGE. In 0139 the wallet counted micro DOLLARS. From 0140 every wallet amount is a count of micro CREDITS:
-- 1 credit = 1,000,000 micro credits. The column names (balance_micro, delta_micro, price_micro, ...) are kept, only their unit
-- changes. A credit is worth different dollars in different packs, so dollars never enter the ledger. The 0139 tables are empty by
-- design (the wallet was never switched on), so there is nothing to convert. This migration is still additive and safe if rows
-- existed: it drops no table or column and deletes or rewrites no row. Rows written under 0139 would keep their old numbers and
-- would NOT be converted, so check that the tables are empty before applying.
--
-- Rules the database itself enforces:
--   1. Credits live in lots (wallet_lots). A lot has remaining and reserved units, never below zero, reserved never above remaining.
--   2. A hold (wallet_holds) reserves credits without debiting them. commit debits exactly the held breakdown; release or expiry frees it.
--   3. Prices come from wallet_prices (post_publish 1 credit, competitor_teardown 10 credits). A caller names an action, never an amount.
--   4. One place decides which lots are spent first (wallet_pick_lots): lots with an expiry first, earliest expiry first, then
--      non-expiring lots by oldest granted_at, id as the tie breaker. Expired lots are never spent. If the spendable total is short the
--      request is refused and nothing changes. Every spend path calls it while holding a row lock on the account.
--   5. Every change carries a key, unique per account. A replay returns the first answer; the same key with another request is refused
--      with idempotency_conflict.
--   6. The ledger stays append only. Entries: grant, charge, hold_commit, expire, with the lot breakdown and the running balance.
--   7. Only the service role can run the functions. Members can read their own account's lots, holds and ledger and write nothing.
--
-- Plan bound credits. A lot can carry bound_plan (the pack bought with a plan gate, and the monthly lots of a plan). The function
-- wallet_revoke_plan(account, plan, lapse_at, reason, key) sets their expiry to lapse_at (now, or a future period end, at most 40
-- days ahead); the one expiry path (wallet_i_sweep, also used by wallet_expire) then writes an expire entry for the unspent amount.
-- Units reserved by a hold in flight stay valid until the hold is committed, released or expired; units freed by a release on a lapsed
-- lot expire right after. WHICH billing statuses call wallet_revoke_plan, and with what lapse_at, is decided by the webhook handler
-- (later). A subscription in past_due during payment retries must NOT lapse anything. wallet_handle_plan_event(account, plan, event,
-- period_end, key, now) holds the policy, in one place, by event:
--   past_due_retry    no lapse, no ledger entry (returns no_lapse)
--   billing_gave_up   plan bound lots and the plan's subscription lots lapse at now
--   voluntary_cancel  the same lots lapse together at period_end (required, in the future, at most 40 days ahead); spendable until then
--   chargeback, refund, admin_termination   the same lots lapse at now
--   any other event   refused with unknown_event
--
-- Helpers named wallet_i_* and wallet_pick_lots are internal: no role but the owner can run them.
-- Idempotent (safe to apply twice) and wrapped in one transaction.
--
-- ROLLBACK (by hand; only safe while no wallet row exists):
--   drop function if exists public.wallet_handle_plan_event(uuid, text, text, timestamptz, text, timestamptz);
--   drop function if exists public.wallet_revoke_plan(uuid, text, timestamptz, text, text);
--   drop function if exists public.wallet_i_revoke(uuid, text, timestamptz, text, text, timestamptz, boolean);
--   drop function if exists public.wallet_grant_for_sku(uuid, text, text, timestamptz, text, timestamptz);
--   drop function if exists public.wallet_balance(uuid, timestamptz);
--   drop function if exists public.wallet_expire_holds(timestamptz);
--   drop function if exists public.wallet_expire(timestamptz);
--   drop function if exists public.wallet_release(uuid);
--   drop function if exists public.wallet_commit(uuid);
--   drop function if exists public.wallet_hold(uuid, text, text);
--   drop function if exists public.wallet_grant(uuid, text, bigint, timestamptz, text);
--   drop function if exists public.wallet_i_grant(uuid, text, bigint, timestamptz, text, text, timestamptz);
--   drop function if exists public.wallet_pick_lots(uuid, bigint, timestamptz);
--   drop function if exists public.wallet_i_spendable(uuid, timestamptz);
--   drop function if exists public.wallet_i_sweep(uuid, timestamptz);
--   drop function if exists public.wallet_i_move(jsonb, text);
--   drop function if exists public.wallet_i_lock(uuid);
--   drop table if exists public.wallet_plan_events, public.wallet_packs, public.wallet_holds, public.wallet_lots;
--   (then re-apply the 0139 bodies of wallet_charge, wallet_credit and wallet_paused_account_ids from 0139)

begin;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Prices: two live actions in micro credits. The two 0139 actions are kept as inactive rows (harmless, never used).
-- ---------------------------------------------------------------------------------------------------------------------------
alter table public.wallet_prices add column if not exists active boolean not null default true;
alter table public.wallet_prices drop constraint if exists wallet_prices_action_type_check;
alter table public.wallet_prices add constraint wallet_prices_action_type_check
  check (action_type in ('api_dispatch', 'sitemap_sync', 'post_publish', 'competitor_teardown'));
insert into public.wallet_prices (action_type, price_micro) values ('post_publish', 1000000), ('competitor_teardown', 10000000)
on conflict (action_type) do nothing;
update public.wallet_prices set active = false where action_type in ('api_dispatch', 'sitemap_sync') and active;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Ledger: new entry kinds, the lot breakdown and the hold. Still append only (the 0139 triggers stay).
-- ---------------------------------------------------------------------------------------------------------------------------
alter table public.wallet_ledger add column if not exists lot_breakdown jsonb;
alter table public.wallet_ledger add column if not exists hold_id uuid;
alter table public.wallet_ledger drop constraint if exists wallet_ledger_kind_check;
alter table public.wallet_ledger add constraint wallet_ledger_kind_check
  check (kind in ('top_up', 'charge', 'refund', 'grant', 'hold_commit', 'expire'));
alter table public.wallet_ledger drop constraint if exists wallet_ledger_action_type_check;
alter table public.wallet_ledger add constraint wallet_ledger_action_type_check
  check (action_type in ('api_dispatch', 'sitemap_sync', 'post_publish', 'competitor_teardown'));
alter table public.wallet_ledger drop constraint if exists wallet_ledger_sign;
alter table public.wallet_ledger add constraint wallet_ledger_sign check (
  (kind in ('charge', 'hold_commit') and delta_micro < 0 and action_type is not null and units is not null)
  or (kind in ('top_up', 'refund', 'grant') and delta_micro > 0 and action_type is null and units is null)
  or (kind = 'expire' and delta_micro < 0 and action_type is null and units is null)
);

-- ---------------------------------------------------------------------------------------------------------------------------
-- Lots, holds, plan events and the pack catalog. RLS is switched on right after each table, before any grant.
-- ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.wallet_lots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  kind text not null check (kind in ('signup', 'pack', 'subscription')),
  granted_units bigint not null check (granted_units > 0),
  remaining_units bigint not null check (remaining_units >= 0),
  reserved_units bigint not null default 0 check (reserved_units >= 0),
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  granted_expires_at timestamptz,
  expired_at timestamptz,
  bound_plan text check (bound_plan is null or bound_plan ~ '^[a-z_]{1,32}$'),
  source_key text not null check (char_length(source_key) between 1 and 100),
  constraint wallet_lots_units check (reserved_units <= remaining_units and remaining_units <= granted_units),
  constraint wallet_lots_expiry_rule check (
    (kind = 'signup' and expires_at is null and bound_plan is null)
    or (kind = 'pack' and (expires_at is null or bound_plan is not null))
    or (kind = 'subscription' and expires_at is not null)
  ),
  constraint wallet_lots_window check (expires_at is null or expires_at >= granted_at),
  constraint wallet_lots_source unique (account_id, source_key)
);
alter table public.wallet_lots enable row level security;
create unique index if not exists wallet_lots_one_signup on public.wallet_lots (account_id) where kind = 'signup';
create index if not exists wallet_lots_pick_idx on public.wallet_lots (account_id, expires_at, granted_at, id);

create table if not exists public.wallet_holds (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  action text not null check (action in ('post_publish', 'competitor_teardown')),
  units bigint not null check (units > 0),
  status text not null default 'held' check (status in ('held', 'committed', 'released', 'expired')),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  breakdown jsonb not null default '[]'::jsonb,
  expires_at timestamptz not null default now() + interval '15 minutes',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint wallet_holds_resolved check ((status = 'held') = (resolved_at is null)),
  constraint wallet_holds_key unique (account_id, idempotency_key)
);
alter table public.wallet_holds enable row level security;
create index if not exists wallet_holds_open_idx on public.wallet_holds (expires_at) where status = 'held';

create table if not exists public.wallet_plan_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  plan text not null,
  reason text not null,
  lapse_at timestamptz not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint wallet_plan_events_key unique (account_id, idempotency_key)
);
alter table public.wallet_plan_events enable row level security;

create table if not exists public.wallet_packs (
  sku text primary key check (char_length(sku) between 1 and 80),
  name text not null,
  kind text not null check (kind in ('pack', 'subscription')),
  price_cents integer not null check (price_cents > 0),
  credits integer not null check (credits > 0),
  expires boolean not null,
  "interval" text not null check ("interval" in ('one_time', 'month')),
  requires_plan text,
  grants_plan text,
  paddle_price_id text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint wallet_packs_shape check (
    (kind = 'pack' and "interval" = 'one_time' and not expires and grants_plan is null)
    or (kind = 'subscription' and "interval" = 'month' and expires and requires_plan is null and grants_plan is not null)
  )
);
alter table public.wallet_packs enable row level security;

insert into public.wallet_packs (sku, name, kind, price_cents, credits, expires, "interval", requires_plan, grants_plan, paddle_price_id, active) values
  ('lazycredits-starter-pack', 'LazyCredits Starter Pack', 'pack', 1500, 300, false, 'one_time', null, null, null, true),
  ('lazycredits-growth-pack', 'LazyCredits Growth Pack', 'pack', 5000, 1500, false, 'one_time', null, null, null, true),
  ('lazycredits-pro-top-up', 'LazyCredits Pro Top-Up', 'pack', 3000, 1500, false, 'one_time', 'pro', null, null, true),
  ('lazyrelay-growth-plan', 'LazyRelay Growth Plan', 'subscription', 2900, 1000, true, 'month', null, 'growth', null, true),
  ('lazyrelay-pro-plan', 'LazyRelay Pro Plan', 'subscription', 9900, 6000, true, 'month', null, 'pro', null, true)
on conflict (sku) do nothing;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Internal helpers (owner only).
-- ---------------------------------------------------------------------------------------------------------------------------
-- The account row lock. Every spend, grant, expiry and revoke takes it first, so parallel calls take turns.
create or replace function public.wallet_i_lock(p_account_id uuid) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_balance bigint;
begin
  insert into public.wallet_accounts (account_id) values (p_account_id) on conflict (account_id) do nothing;
  select balance_micro into v_balance from public.wallet_accounts where account_id = p_account_id for update;
  return v_balance;
end;
$$;

-- Credits that can be spent right now: unreserved units of lots that have not expired.
create or replace function public.wallet_i_spendable(p_account_id uuid, p_now timestamptz) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(remaining_units - reserved_units), 0)::bigint from public.wallet_lots
  where account_id = p_account_id and (expires_at is null or expires_at > p_now);
$$;

-- THE bucket order, in one place. Returns the lots to take from, in order, only when the whole request can be covered.
create or replace function public.wallet_pick_lots(p_account_id uuid, p_units bigint, p_now timestamptz)
returns table (lot_id uuid, take_units bigint, ord bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  with spendable as (
    select l.id, l.remaining_units - l.reserved_units as avail,
           row_number() over (order by (l.expires_at is null), l.expires_at, l.granted_at, l.id) as rn
    from public.wallet_lots l
    where l.account_id = p_account_id and (l.expires_at is null or l.expires_at > p_now) and l.remaining_units - l.reserved_units > 0
  ), running as (
    select s.id, s.avail, s.rn,
           coalesce(sum(s.avail) over (order by s.rn rows between unbounded preceding and 1 preceding), 0) as before_sum,
           sum(s.avail) over () as total
    from spendable s
  )
  select r.id, least(r.avail, p_units - r.before_sum)::bigint, r.rn
  from running r where p_units > 0 and r.total >= p_units and r.before_sum < p_units order by r.rn;
$$;

-- Applies a breakdown [{lot_id, units}] to the lots: reserve, unreserve, commit (debit reserved units) or debit.
create or replace function public.wallet_i_move(p_breakdown jsonb, p_mode text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.wallet_lots l set
    reserved_units = l.reserved_units + case p_mode when 'reserve' then x.units when 'unreserve' then -x.units when 'commit' then -x.units else 0 end,
    remaining_units = l.remaining_units - case p_mode when 'debit' then x.units when 'commit' then x.units else 0 end
  from jsonb_to_recordset(p_breakdown) as x (lot_id uuid, units bigint)
  where l.id = x.lot_id;
end;
$$;

-- The ONE expiry path. Expires the unreserved units of every lot whose expiry has passed, one expire entry per lot.
-- The caller holds the account lock. Units reserved by a hold in flight are left alone until the hold resolves.
create or replace function public.wallet_i_sweep(p_account_id uuid, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_balance bigint;
  v_total bigint := 0;
  v_count integer := 0;
  v_seq integer;
begin
  select balance_micro into v_balance from public.wallet_accounts where account_id = p_account_id;
  for r in
    select id, remaining_units - reserved_units as amt from public.wallet_lots
    where account_id = p_account_id and expires_at is not null and expires_at <= p_now and remaining_units - reserved_units > 0
    order by expires_at, granted_at, id
  loop
    v_balance := v_balance - r.amt;
    update public.wallet_lots set remaining_units = remaining_units - r.amt, expired_at = coalesce(expired_at, p_now) where id = r.id;
    select count(*) + 1 into v_seq from public.wallet_ledger where account_id = p_account_id and kind = 'expire' and lot_breakdown -> 0 ->> 'lot_id' = r.id::text;
    insert into public.wallet_ledger (account_id, kind, delta_micro, balance_after_micro, idempotency_key, reference, lot_breakdown)
    values (p_account_id, 'expire', -r.amt, v_balance, 'expire:' || r.id || ':' || v_seq, 'lot expired',
            jsonb_build_array(jsonb_build_object('lot_id', r.id, 'units', r.amt)));
    v_total := v_total + r.amt;
    v_count := v_count + 1;
  end loop;
  if v_count > 0 then update public.wallet_accounts set balance_micro = v_balance, updated_at = now() where account_id = p_account_id; end if;
  return jsonb_build_object('expired_lots', v_count, 'expired_micro', v_total);
end;
$$;

-- Grant one lot. The public wallet_grant and wallet_grant_for_sku both end here.
create or replace function public.wallet_i_grant(p_account_id uuid, p_kind text, p_units bigint, p_expires_at timestamptz, p_source_key text, p_bound_plan text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lot public.wallet_lots%rowtype;
  v_balance bigint;
  v_id uuid;
begin
  if p_account_id is null then raise exception 'wallet_grant: account is required' using errcode = 'invalid_parameter_value'; end if;
  if p_kind is null or p_kind not in ('signup', 'pack', 'subscription') then raise exception 'wallet_grant: kind must be signup, pack or subscription' using errcode = 'invalid_parameter_value'; end if;
  if p_units is null or p_units <= 0 or p_units > 1000000000000 then raise exception 'wallet_grant: units must be above zero and within the limit' using errcode = 'invalid_parameter_value'; end if;
  if p_source_key is null or char_length(p_source_key) < 1 or char_length(p_source_key) > 100 then raise exception 'wallet_grant: a source key of 1 to 100 characters is required' using errcode = 'invalid_parameter_value'; end if;
  if (p_kind = 'subscription') <> (p_expires_at is not null) then raise exception 'wallet_grant: only a subscription lot has an expiry, and it must have one' using errcode = 'invalid_parameter_value'; end if;
  if p_kind = 'signup' and p_bound_plan is not null then raise exception 'wallet_grant: a signup lot cannot be bound to a plan' using errcode = 'invalid_parameter_value'; end if;

  v_balance := public.wallet_i_lock(p_account_id);
  select * into v_lot from public.wallet_lots where account_id = p_account_id and source_key = p_source_key;
  if found then
    if v_lot.kind <> p_kind or v_lot.granted_units <> p_units or v_lot.granted_expires_at is distinct from p_expires_at or v_lot.bound_plan is distinct from p_bound_plan then
      raise exception 'idempotency_conflict' using errcode = 'unique_violation';
    end if;
    return jsonb_build_object('ok', true, 'replay', true, 'lot_id', v_lot.id, 'granted_micro', v_lot.granted_units, 'balance_micro', v_balance);
  end if;
  if p_kind = 'subscription' and p_expires_at <= p_now then raise exception 'wallet_grant: the expiry must be in the future' using errcode = 'invalid_parameter_value'; end if;
  if p_kind = 'signup' and exists (select 1 from public.wallet_lots where account_id = p_account_id and kind = 'signup') then
    raise exception 'signup_already_granted' using errcode = 'unique_violation';
  end if;

  perform public.wallet_i_sweep(p_account_id, p_now);
  select balance_micro into v_balance from public.wallet_accounts where account_id = p_account_id;
  insert into public.wallet_lots (account_id, kind, granted_units, remaining_units, granted_at, expires_at, granted_expires_at, bound_plan, source_key)
  values (p_account_id, p_kind, p_units, p_units, p_now, p_expires_at, p_expires_at, p_bound_plan, p_source_key) returning id into v_id;
  update public.wallet_accounts set balance_micro = v_balance + p_units, updated_at = now() where account_id = p_account_id;
  insert into public.wallet_ledger (account_id, kind, delta_micro, balance_after_micro, idempotency_key, reference, lot_breakdown)
  values (p_account_id, 'grant', p_units, v_balance + p_units, 'grant:' || p_source_key, p_kind, jsonb_build_array(jsonb_build_object('lot_id', v_id, 'units', p_units)));
  return jsonb_build_object('ok', true, 'replay', false, 'lot_id', v_id, 'granted_micro', p_units, 'balance_micro', v_balance + p_units);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Public functions (service role only).
-- ---------------------------------------------------------------------------------------------------------------------------
create or replace function public.wallet_grant(p_account_id uuid, p_kind text, p_units bigint, p_expires_at timestamptz, p_source_key text) returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select public.wallet_i_grant(p_account_id, p_kind, p_units, p_expires_at, p_source_key, null, now());
$$;

-- Grants a catalog SKU. The amount, the lot kind and the binding come from wallet_packs, never from the caller. A SKU that needs a
-- plan is refused with plan_required unless p_active_plan equals it; the webhook handler supplies the plan. A subscription SKU
-- takes the period end as the expiry. A replay of an earlier grant returns the first answer without asking for the plan again.
create or replace function public.wallet_grant_for_sku(p_account_id uuid, p_sku text, p_source_key text, p_now timestamptz, p_active_plan text, p_period_end timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pack public.wallet_packs%rowtype;
begin
  if p_now is null then raise exception 'wallet_grant_for_sku: a clock is required' using errcode = 'invalid_parameter_value'; end if;
  select * into v_pack from public.wallet_packs where sku = p_sku and active;
  if not found then raise exception 'wallet_grant_for_sku: unknown sku' using errcode = 'invalid_parameter_value'; end if;
  if v_pack.requires_plan is not null and p_active_plan is distinct from v_pack.requires_plan
     and not exists (select 1 from public.wallet_lots where account_id = p_account_id and source_key = p_source_key) then
    return jsonb_build_object('ok', false, 'reason', 'plan_required', 'required_plan', v_pack.requires_plan);
  end if;
  return public.wallet_i_grant(p_account_id, v_pack.kind, v_pack.credits::bigint * 1000000,
    case when v_pack.kind = 'subscription' then p_period_end else null end, p_source_key, coalesce(v_pack.requires_plan, v_pack.grants_plan), p_now)
    || jsonb_build_object('sku', v_pack.sku);
end;
$$;

create or replace function public.wallet_hold(p_account_id uuid, p_action text, p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_price bigint;
  v_existing public.wallet_holds%rowtype;
  v_breakdown jsonb;
  v_id uuid;
begin
  if p_account_id is null then raise exception 'wallet_hold: account is required' using errcode = 'invalid_parameter_value'; end if;
  if p_key is null or char_length(p_key) < 1 or char_length(p_key) > 128 then raise exception 'wallet_hold: a key of 1 to 128 characters is required' using errcode = 'invalid_parameter_value'; end if;
  select price_micro into v_price from public.wallet_prices where action_type = p_action and active;
  if v_price is null then raise exception 'wallet_hold: unknown action' using errcode = 'invalid_parameter_value'; end if;
  if exists (select 1 from public.wallet_legacy_accounts where account_id = p_account_id) then
    return jsonb_build_object('ok', true, 'replay', false, 'exempt', true, 'held_micro', 0);
  end if;

  perform public.wallet_i_lock(p_account_id);
  select * into v_existing from public.wallet_holds where account_id = p_account_id and idempotency_key = p_key;
  if found then
    if v_existing.action <> p_action then raise exception 'idempotency_conflict' using errcode = 'unique_violation'; end if;
    return jsonb_build_object('ok', true, 'replay', true, 'hold_id', v_existing.id, 'held_micro', v_existing.units, 'status', v_existing.status);
  end if;

  perform public.wallet_i_sweep(p_account_id, now());
  select jsonb_agg(jsonb_build_object('lot_id', p.lot_id, 'units', p.take_units) order by p.ord) into v_breakdown from public.wallet_pick_lots(p_account_id, v_price, now()) p;
  if v_breakdown is null then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_credits', 'balance_micro', public.wallet_i_spendable(p_account_id, now()), 'required_micro', v_price);
  end if;
  perform public.wallet_i_move(v_breakdown, 'reserve');
  insert into public.wallet_holds (account_id, action, units, idempotency_key, breakdown) values (p_account_id, p_action, v_price, p_key, v_breakdown) returning id into v_id;
  return jsonb_build_object('ok', true, 'replay', false, 'hold_id', v_id, 'held_micro', v_price);
end;
$$;

create or replace function public.wallet_commit(p_hold_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_account uuid;
  v_hold public.wallet_holds%rowtype;
  v_balance bigint;
begin
  select account_id into v_account from public.wallet_holds where id = p_hold_id;
  if v_account is null then raise exception 'wallet_commit: hold not found' using errcode = 'invalid_parameter_value'; end if;
  perform public.wallet_i_lock(v_account);
  select * into v_hold from public.wallet_holds where id = p_hold_id for update;
  if v_hold.status = 'committed' then
    return jsonb_build_object('ok', true, 'replay', true, 'committed_micro', v_hold.units, 'balance_micro', (select balance_micro from public.wallet_accounts where account_id = v_account));
  end if;
  if v_hold.status <> 'held' then return jsonb_build_object('ok', false, 'reason', 'hold_not_held', 'status', v_hold.status); end if;

  select balance_micro into v_balance from public.wallet_accounts where account_id = v_account;
  perform public.wallet_i_move(v_hold.breakdown, 'commit');
  update public.wallet_accounts set balance_micro = v_balance - v_hold.units, updated_at = now() where account_id = v_account;
  insert into public.wallet_ledger (account_id, kind, action_type, units, delta_micro, balance_after_micro, idempotency_key, lot_breakdown, hold_id)
  values (v_account, 'hold_commit', v_hold.action, 1, -v_hold.units, v_balance - v_hold.units, 'commit:' || v_hold.id, v_hold.breakdown, v_hold.id);
  update public.wallet_holds set status = 'committed', resolved_at = now() where id = v_hold.id;
  return jsonb_build_object('ok', true, 'replay', false, 'committed_micro', v_hold.units, 'balance_micro', v_balance - v_hold.units);
end;
$$;

create or replace function public.wallet_release(p_hold_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_account uuid;
  v_hold public.wallet_holds%rowtype;
begin
  select account_id into v_account from public.wallet_holds where id = p_hold_id;
  if v_account is null then raise exception 'wallet_release: hold not found' using errcode = 'invalid_parameter_value'; end if;
  perform public.wallet_i_lock(v_account);
  select * into v_hold from public.wallet_holds where id = p_hold_id for update;
  if v_hold.status = 'released' then return jsonb_build_object('ok', true, 'replay', true); end if;
  if v_hold.status <> 'held' then return jsonb_build_object('ok', false, 'reason', 'hold_not_held', 'status', v_hold.status); end if;
  perform public.wallet_i_move(v_hold.breakdown, 'unreserve');
  update public.wallet_holds set status = 'released', resolved_at = now() where id = v_hold.id;
  perform public.wallet_i_sweep(v_account, now());
  return jsonb_build_object('ok', true, 'replay', false);
end;
$$;

-- Direct charge (posts): units is a count of the action, the price comes from wallet_prices.
create or replace function public.wallet_charge(p_account_id uuid, p_action text, p_units integer, p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_price bigint;
  v_cost bigint;
  v_balance bigint;
  v_existing public.wallet_ledger%rowtype;
  v_breakdown jsonb;
begin
  if p_account_id is null then raise exception 'wallet_charge: account is required' using errcode = 'invalid_parameter_value'; end if;
  if p_units is null or p_units < 1 or p_units > 10000 then raise exception 'wallet_charge: units must be from 1 to 10000' using errcode = 'invalid_parameter_value'; end if;
  if p_key is null or char_length(p_key) < 1 or char_length(p_key) > 128 then raise exception 'wallet_charge: a key of 1 to 128 characters is required' using errcode = 'invalid_parameter_value'; end if;
  select price_micro into v_price from public.wallet_prices where action_type = p_action and active;
  if v_price is null then raise exception 'wallet_charge: unknown action' using errcode = 'invalid_parameter_value'; end if;
  v_cost := v_price * p_units;
  if exists (select 1 from public.wallet_legacy_accounts where account_id = p_account_id) then
    return jsonb_build_object('ok', true, 'replay', false, 'exempt', true, 'charged_micro', 0,
      'balance_micro', coalesce((select balance_micro from public.wallet_accounts where account_id = p_account_id), 0));
  end if;

  v_balance := public.wallet_i_lock(p_account_id);
  select * into v_existing from public.wallet_ledger where account_id = p_account_id and idempotency_key = p_key;
  if found then
    if v_existing.kind <> 'charge' or v_existing.action_type <> p_action or v_existing.units <> p_units then raise exception 'idempotency_conflict' using errcode = 'unique_violation'; end if;
    return jsonb_build_object('ok', true, 'replay', true, 'charged_micro', -v_existing.delta_micro, 'balance_micro', v_balance);
  end if;

  perform public.wallet_i_sweep(p_account_id, now());
  select balance_micro into v_balance from public.wallet_accounts where account_id = p_account_id;
  select jsonb_agg(jsonb_build_object('lot_id', p.lot_id, 'units', p.take_units) order by p.ord) into v_breakdown from public.wallet_pick_lots(p_account_id, v_cost, now()) p;
  if v_breakdown is null then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_credits', 'balance_micro', public.wallet_i_spendable(p_account_id, now()), 'required_micro', v_cost);
  end if;
  perform public.wallet_i_move(v_breakdown, 'debit');
  update public.wallet_accounts set balance_micro = v_balance - v_cost, updated_at = now() where account_id = p_account_id;
  insert into public.wallet_ledger (account_id, kind, action_type, units, delta_micro, balance_after_micro, idempotency_key, lot_breakdown)
  values (p_account_id, 'charge', p_action, p_units, -v_cost, v_balance - v_cost, p_key, v_breakdown);
  return jsonb_build_object('ok', true, 'replay', false, 'charged_micro', v_cost, 'balance_micro', v_balance - v_cost);
end;
$$;

create or replace function public.wallet_expire(p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_one jsonb;
  v_lots integer := 0;
  v_micro bigint := 0;
begin
  if p_now is null then raise exception 'wallet_expire: a clock is required' using errcode = 'invalid_parameter_value'; end if;
  for r in
    select distinct account_id from public.wallet_lots
    where expires_at is not null and expires_at <= p_now and remaining_units - reserved_units > 0 order by account_id
  loop
    perform public.wallet_i_lock(r.account_id);
    v_one := public.wallet_i_sweep(r.account_id, p_now);
    v_lots := v_lots + (v_one ->> 'expired_lots')::integer;
    v_micro := v_micro + (v_one ->> 'expired_micro')::bigint;
  end loop;
  return jsonb_build_object('expired_lots', v_lots, 'expired_micro', v_micro);
end;
$$;

create or replace function public.wallet_expire_holds(p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  h record;
  v_count integer := 0;
begin
  if p_now is null then raise exception 'wallet_expire_holds: a clock is required' using errcode = 'invalid_parameter_value'; end if;
  for r in select distinct account_id from public.wallet_holds where status = 'held' and expires_at <= p_now order by account_id loop
    perform public.wallet_i_lock(r.account_id);
    for h in select id, breakdown from public.wallet_holds where account_id = r.account_id and status = 'held' and expires_at <= p_now order by id for update loop
      perform public.wallet_i_move(h.breakdown, 'unreserve');
      update public.wallet_holds set status = 'expired', resolved_at = p_now where id = h.id;
      v_count := v_count + 1;
    end loop;
    perform public.wallet_i_sweep(r.account_id, now());
  end loop;
  return jsonb_build_object('expired_holds', v_count);
end;
$$;

-- Cancels the credits tied to a plan (internal). Sets the expiry of every unspent lot bound to the plan to the lapse time (not before
-- p_now) and lets the one expiry path write the entries. Idempotent by key; the same key with other arguments is refused. The lapse
-- time is compared on a replay only when p_compare_lapse is true (an immediate event is replayed with a later clock).
create or replace function public.wallet_i_revoke(p_account_id uuid, p_plan text, p_lapse_at timestamptz, p_reason text, p_key text, p_now timestamptz, p_compare_lapse boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event public.wallet_plan_events%rowtype;
  v_effective timestamptz;
  v_revoked integer;
  v_swept jsonb;
  v_result jsonb;
begin
  if p_account_id is null then raise exception 'wallet_revoke_plan: account is required' using errcode = 'invalid_parameter_value'; end if;
  if p_plan is null or p_plan !~ '^[a-z_]{1,32}$' then raise exception 'wallet_revoke_plan: plan is not valid' using errcode = 'invalid_parameter_value'; end if;
  if p_key is null or char_length(p_key) < 1 or char_length(p_key) > 128 then raise exception 'wallet_revoke_plan: a key of 1 to 128 characters is required' using errcode = 'invalid_parameter_value'; end if;
  if p_now is null or p_lapse_at is null or p_lapse_at > p_now + interval '40 days' then raise exception 'wallet_revoke_plan: lapse_at is missing or more than 40 days ahead' using errcode = 'invalid_parameter_value'; end if;

  perform public.wallet_i_lock(p_account_id);
  select * into v_event from public.wallet_plan_events where account_id = p_account_id and idempotency_key = p_key;
  if found then
    if v_event.plan <> p_plan or v_event.reason <> p_reason or (p_compare_lapse and v_event.lapse_at <> p_lapse_at) then raise exception 'idempotency_conflict' using errcode = 'unique_violation'; end if;
    return v_event.result || jsonb_build_object('replay', true);
  end if;

  v_effective := greatest(p_lapse_at, p_now);
  update public.wallet_lots set expires_at = greatest(least(coalesce(expires_at, v_effective), v_effective), granted_at)
  where account_id = p_account_id and bound_plan = p_plan and remaining_units > 0 and (expires_at is null or expires_at > v_effective);
  get diagnostics v_revoked = row_count;
  v_swept := public.wallet_i_sweep(p_account_id, p_now);
  v_result := jsonb_build_object('ok', true, 'replay', false, 'lots_revoked', v_revoked, 'expired_micro', (v_swept ->> 'expired_micro')::bigint, 'lapse_at', v_effective);
  insert into public.wallet_plan_events (account_id, idempotency_key, plan, reason, lapse_at, result) values (p_account_id, p_key, p_plan, p_reason, p_lapse_at, v_result);
  return v_result;
end;
$$;

create or replace function public.wallet_revoke_plan(p_account_id uuid, p_plan text, p_lapse_at timestamptz, p_reason text, p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_reason is null or p_reason not in ('canceled', 'terminated', 'billing_inactive', 'chargeback', 'refund') then raise exception 'wallet_revoke_plan: reason is not allowed' using errcode = 'invalid_parameter_value'; end if;
  return public.wallet_i_revoke(p_account_id, p_plan, p_lapse_at, p_reason, p_key, now(), true);
end;
$$;

-- The lapse policy, in one place (see the header table). The webhook handler (later) names the event; the timing is decided here.
create or replace function public.wallet_handle_plan_event(p_account_id uuid, p_plan text, p_event text, p_period_end timestamptz, p_key text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_event is null or p_event not in ('past_due_retry', 'billing_gave_up', 'voluntary_cancel', 'chargeback', 'refund', 'admin_termination') then
    raise exception 'unknown_event' using errcode = 'invalid_parameter_value';
  end if;
  if p_now is null then raise exception 'wallet_handle_plan_event: a clock is required' using errcode = 'invalid_parameter_value'; end if;
  if p_event = 'past_due_retry' then return jsonb_build_object('ok', true, 'outcome', 'no_lapse'); end if;
  if p_event = 'voluntary_cancel' then
    if p_period_end is null or p_period_end <= p_now or p_period_end > p_now + interval '40 days' then
      raise exception 'wallet_handle_plan_event: period_end is required, in the future and at most 40 days ahead' using errcode = 'invalid_parameter_value';
    end if;
    return public.wallet_i_revoke(p_account_id, p_plan, p_period_end, p_event, p_key, p_now, true);
  end if;
  return public.wallet_i_revoke(p_account_id, p_plan, p_now, p_event, p_key, p_now, false);
end;
$$;

-- For the dashboard: spendable and held credits and the next expiry (date and amount).
create or replace function public.wallet_balance(p_account_id uuid, p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_next timestamptz;
begin
  select min(expires_at) into v_next from public.wallet_lots
  where account_id = p_account_id and expires_at > p_now and remaining_units - reserved_units > 0;
  return jsonb_build_object(
    'spendable_micro', public.wallet_i_spendable(p_account_id, p_now),
    'held_micro', (select coalesce(sum(reserved_units), 0)::bigint from public.wallet_lots where account_id = p_account_id),
    'next_expiry_at', v_next,
    'next_expiry_micro', case when v_next is null then null else
      (select sum(remaining_units - reserved_units)::bigint from public.wallet_lots where account_id = p_account_id and expires_at = v_next) end);
end;
$$;

-- 0139 functions that change meaning. wallet_credit is retired (it would add a balance with no lot behind it).
create or replace function public.wallet_credit(p_account_id uuid, p_amount_micro bigint, p_key text, p_reference text default null, p_kind text default 'top_up') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  raise exception 'wallet_credit is retired: use wallet_grant' using errcode = 'invalid_parameter_value';
end;
$$;

create or replace function public.wallet_paused_account_ids(p_min bigint default 2000) returns setof uuid
language plpgsql security definer stable set search_path = public, pg_temp as $$
begin
  if p_min is null or p_min < 1 then raise exception 'wallet_paused_account_ids: p_min must be above zero' using errcode = 'invalid_parameter_value'; end if;
  return query
    select w.account_id from public.wallet_accounts w
    where public.wallet_i_spendable(w.account_id, now()) < p_min and not exists (select 1 from public.wallet_legacy_accounts l where l.account_id = w.account_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Access. One policy per command: members read their own account's rows. Nobody in the browser writes. The service role gets
-- SELECT only; its writes go through the functions.
-- ---------------------------------------------------------------------------------------------------------------------------
drop policy if exists wallet_lots_select_members on public.wallet_lots;
create policy wallet_lots_select_members on public.wallet_lots for select to authenticated using (is_account_member(account_id));
drop policy if exists wallet_holds_select_members on public.wallet_holds;
create policy wallet_holds_select_members on public.wallet_holds for select to authenticated using (is_account_member(account_id));
drop policy if exists wallet_packs_select_active on public.wallet_packs;
create policy wallet_packs_select_active on public.wallet_packs for select to authenticated using (active);

revoke all on public.wallet_lots, public.wallet_holds, public.wallet_plan_events, public.wallet_packs from public, anon, authenticated, service_role;
grant select on public.wallet_lots, public.wallet_holds, public.wallet_packs to authenticated, service_role;
grant select on public.wallet_plan_events to service_role;
grant select on public.wallet_prices to authenticated, service_role;

revoke all on function public.wallet_i_lock(uuid) from public, anon, authenticated, service_role;
revoke all on function public.wallet_i_spendable(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.wallet_pick_lots(uuid, bigint, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.wallet_i_move(jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.wallet_i_sweep(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.wallet_i_grant(uuid, text, bigint, timestamptz, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.wallet_i_revoke(uuid, text, timestamptz, text, text, timestamptz, boolean) from public, anon, authenticated, service_role;

revoke all on function public.wallet_grant(uuid, text, bigint, timestamptz, text) from public, anon, authenticated;
revoke all on function public.wallet_grant_for_sku(uuid, text, text, timestamptz, text, timestamptz) from public, anon, authenticated;
revoke all on function public.wallet_hold(uuid, text, text) from public, anon, authenticated;
revoke all on function public.wallet_commit(uuid) from public, anon, authenticated;
revoke all on function public.wallet_release(uuid) from public, anon, authenticated;
revoke all on function public.wallet_charge(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.wallet_expire(timestamptz) from public, anon, authenticated;
revoke all on function public.wallet_expire_holds(timestamptz) from public, anon, authenticated;
revoke all on function public.wallet_revoke_plan(uuid, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.wallet_handle_plan_event(uuid, text, text, timestamptz, text, timestamptz) from public, anon, authenticated;
revoke all on function public.wallet_balance(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.wallet_credit(uuid, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.wallet_paused_account_ids(bigint) from public, anon, authenticated;
grant execute on function public.wallet_grant(uuid, text, bigint, timestamptz, text) to service_role;
grant execute on function public.wallet_grant_for_sku(uuid, text, text, timestamptz, text, timestamptz) to service_role;
grant execute on function public.wallet_hold(uuid, text, text) to service_role;
grant execute on function public.wallet_commit(uuid) to service_role;
grant execute on function public.wallet_release(uuid) to service_role;
grant execute on function public.wallet_charge(uuid, text, integer, text) to service_role;
grant execute on function public.wallet_expire(timestamptz) to service_role;
grant execute on function public.wallet_expire_holds(timestamptz) to service_role;
grant execute on function public.wallet_revoke_plan(uuid, text, timestamptz, text, text) to service_role;
grant execute on function public.wallet_handle_plan_event(uuid, text, text, timestamptz, text, timestamptz) to service_role;
grant execute on function public.wallet_balance(uuid, timestamptz) to service_role;
grant execute on function public.wallet_credit(uuid, bigint, text, text, text) to service_role;
grant execute on function public.wallet_paused_account_ids(bigint) to service_role;

commit;
