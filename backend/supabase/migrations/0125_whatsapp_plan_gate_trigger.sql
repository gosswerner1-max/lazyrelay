-- 0125: WhatsApp plan gate in the DATABASE (defence in depth for 0124).
--
-- DRAFT for review on branch feature/whatsapp-byok. NOT applied anywhere. Applied by hand with Werner's yes, after 0124.
--
-- Why. The WhatsApp plan gate (Business, Agency, Agency Plus) lives in the backend (accountLimits.ts checkWhatsappPlan,
-- called by the BYOK routes and the generic connect route). But 0081's RLS lets any account member write
-- social_accounts directly (insert and update policies), so a member on Free, Starter or Pro could skip the backend and turn
-- their own telegram row into a whatsapp byok row, or insert one. A CHECK constraint cannot read another table, so the
-- rule is a BEFORE INSERT OR UPDATE trigger. It applies to every role including service_role: the backend gate stays and
-- this is the backstop.
--
-- The rule. Whenever NEW.platform = 'whatsapp' and the write CREATES or CHANGES the WhatsApp state, the owning account
-- must have a subscription with status active or trialing (the same "good standing" test as resolveTier in
-- backend/src/tier.ts) and a tier in ('business', 'agency', 'agency_plus') (WHATSAPP_BYOK_ALLOWED_TIERS in tier.ts; a
-- vitest keeps the two lists equal). No subscription row, or any other status, fails CLOSED.
-- "Creates or changes" means: an INSERT; or an UPDATE where the row was not whatsapp before; or an UPDATE that changes
-- account_id, credential_mode, whatsapp_business_account_id or whatsapp_phone_number_id.
--
-- What it does NOT block, so a downgrade or cancellation never strands an existing connection: any other UPDATE of an
-- existing whatsapp row (disconnected_at, the 0117 token wipe, needs_reconnect flags, paused_at, byok_status, display
-- name, token columns, brand). DELETE is not trigger-checked. Note an upsert (INSERT ... ON CONFLICT DO UPDATE) runs the
-- BEFORE INSERT trigger first, so re-saving credentials through the route on a downgraded plan is blocked too, which is
-- the intent (the route blocks it earlier anyway).
--
-- Error. SQLSTATE 'LRWA1' (a class of our own, so nothing else can raise it by accident) with the message
-- 'whatsapp requires the Business plan or above'. The backend maps either to the existing HTTP 400 plan message.
--
-- Function hardening, same pattern as 0003, 0055 and 0088: SECURITY DEFINER (so it can read subscriptions whatever the
-- caller's RLS says), search_path = public, pg_temp, every object schema-qualified, EXECUTE revoked from PUBLIC (a trigger
-- function is never called directly, and trigger execution does not check the caller's EXECUTE right). Owner: whoever runs
-- the migration (postgres on Supabase); do not change it, the owner must be able to read subscriptions (RLS does not apply
-- to a table owner).

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
     and v_tier in ('business', 'agency', 'agency_plus')
  then
    return new;
  end if;

  raise exception 'whatsapp requires the Business plan or above' using errcode = 'LRWA1';
end;
$$;

revoke execute on function public.enforce_whatsapp_plan_gate() from public;

drop trigger if exists social_accounts_whatsapp_plan_gate on public.social_accounts;
create trigger social_accounts_whatsapp_plan_gate
  before insert or update on public.social_accounts
  for each row execute function public.enforce_whatsapp_plan_gate();

commit;

-- ROLLBACK (manual, in one transaction; nothing else depends on it):
--   begin;
--   drop trigger if exists social_accounts_whatsapp_plan_gate on public.social_accounts;
--   drop function if exists public.enforce_whatsapp_plan_gate();
--   commit;
