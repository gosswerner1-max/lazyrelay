-- 0132: the database backstop for the "own keys" plan gates now allows EVERY PAID tier (Werner, 2026-10-16).
--
-- DRAFT for review on branch fix/whatsapp-byok-no-caps. NOT applied anywhere. Apply by hand with Werner's yes, on a throwaway Supabase
-- branch first (the repo has no SQL test harness: this file has only been read and checked as text).
--
-- Why. WhatsApp and X are bring-your-own-key: the customer pays Meta and X directly with their own tokens, so LazyRelay does not meter
-- them. The only product restriction is the PLAN GATE: Free (and a lapsed plan, which resolveTier counts as Free) is refused, every
-- paid tier (starter, pro, business, agency, agency_plus) is allowed. The backend lists (WHATSAPP_BYOK_ALLOWED_TIERS and
-- X_BYOK_ALLOWED_TIERS in tier.ts) now say exactly that. Migrations 0125 (WhatsApp, Business and above) and 0126 (X, Pro and above)
-- created the two trigger functions with the OLD lists, so a Starter (or Pro, for WhatsApp) customer would pass the backend and then be
-- refused by the database. This migration replaces both functions with the new list. Triggers, SQLSTATEs ('LRWA1', 'LRXB1'), the
-- "good standing" test (status active or trialing) and everything else are exactly as in 0125 and 0126; only the tier list and the
-- message text change. The backend recognises the old and the new message (and the SQLSTATE), so the order of deployment does not
-- matter.
--
-- Apply order: after 0125 and 0126 (it replaces their functions; the triggers themselves are untouched).
--
-- ROLLBACK (manual): re-run the create or replace function statements of 0125 and 0126.

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
     and v_tier in ('starter', 'pro', 'business', 'agency', 'agency_plus')
  then
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
     and v_tier in ('starter', 'pro', 'business', 'agency', 'agency_plus')
  then
    return new;
  end if;

  raise exception 'x own keys requires a paid plan' using errcode = 'LRXB1';
end;
$$;

revoke execute on function public.enforce_x_byok_plan_gate() from public, anon, authenticated;

commit;
