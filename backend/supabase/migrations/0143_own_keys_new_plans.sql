-- 0143: the "own keys" database backstop now also allows the wallet plans: growth, lazy_pro and payg.
--
-- DRAFT for review on branch feature/billing-wiring. NOT applied anywhere. Apply by hand with Werner's yes, on a throwaway Supabase
-- branch first. Idempotent: it only uses CREATE OR REPLACE on the two functions of 0125/0126/0132; the triggers are untouched.
--
-- Why. WhatsApp and X own keys are allowed on every plan except Free. tier.ts (X_BYOK_ALLOWED_TIERS, WHATSAPP_BYOK_ALLOWED_TIERS) now
-- also lists growth, lazy_pro and payg. Without this migration those customers would pass the backend and be refused by the database.
--
-- The one behaviour change against 0132: v_tier in (...) gains 'growth' and 'lazy_pro' (stored tiers). payg is DERIVED, never stored in
-- subscriptions (a free account that unlocked pay as you go), so it is allowed by a second test: accounts.payg_unlocked_at is not null
-- (the same fact resolveTier reads, column from 0141). Everything else (good-standing status test for stored tiers, the 'no change to
-- an existing row' short cut, SQLSTATEs LRWA1 and LRXB1, messages, hardening) is identical to 0132.
--
-- ROLLBACK (manual): re-run the create or replace function statements of 0132.

begin;

create or replace function public.enforce_whatsapp_plan_gate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tier text;
  v_status text;
begin
  if new.platform is distinct from 'whatsapp' then
    return new;
  end if;

  -- An ordinary update of an EXISTING whatsapp row that does not touch what makes it a whatsapp connection.
  if tg_op = 'UPDATE'
     and old.platform = 'whatsapp'
     and old.account_id is not distinct from new.account_id
     and old.credential_mode is not distinct from new.credential_mode
     and old.whatsapp_business_account_id is not distinct from new.whatsapp_business_account_id
     and old.whatsapp_phone_number_id is not distinct from new.whatsapp_phone_number_id
  then
    return new;
  end if;

  select s.tier, s.status into v_tier, v_status
  from public.subscriptions s
  where s.account_id = new.account_id;

  -- "found" is false with no subscription row; null tier or status also falls through to the exception (fail closed).
  if found
     and v_status in ('active', 'trialing')
     and v_tier in ('starter', 'pro', 'business', 'agency', 'agency_plus', 'growth', 'lazy_pro')
  then
    return new;
  end if;

  -- payg is derived (a free account that unlocked pay as you go), so it has no subscriptions row to read the tier from.
  if exists (select 1 from public.accounts a where a.id = new.account_id and a.payg_unlocked_at is not null) then
    return new;
  end if;

  raise exception 'whatsapp requires a paid plan' using errcode = 'LRWA1';
end;
$$;

revoke execute on function public.enforce_whatsapp_plan_gate() from public;

create or replace function public.enforce_x_byok_plan_gate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tier text;
  v_status text;
begin
  -- Only X rows on the customer's own keys are gated.
  if new.platform is distinct from 'x' or new.credential_mode is distinct from 'byok' then
    return new;
  end if;

  -- An ordinary update of an EXISTING x byok row that does not touch what makes it that connection.
  if tg_op = 'UPDATE'
     and old.platform = 'x'
     and old.credential_mode = 'byok'
     and old.account_id is not distinct from new.account_id
     and old.platform_account_id is not distinct from new.platform_account_id
  then
    return new;
  end if;

  select s.tier, s.status into v_tier, v_status
  from public.subscriptions s
  where s.account_id = new.account_id;

  if found
     and v_status in ('active', 'trialing')
     and v_tier in ('starter', 'pro', 'business', 'agency', 'agency_plus', 'growth', 'lazy_pro')
  then
    return new;
  end if;

  -- payg is derived (a free account that unlocked pay as you go), so it has no subscriptions row to read the tier from.
  if exists (select 1 from public.accounts a where a.id = new.account_id and a.payg_unlocked_at is not null) then
    return new;
  end if;

  raise exception 'x own keys requires a paid plan' using errcode = 'LRXB1';
end;
$$;

revoke execute on function public.enforce_x_byok_plan_gate() from public, anon, authenticated;

commit;
