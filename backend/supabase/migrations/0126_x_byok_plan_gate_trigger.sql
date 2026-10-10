-- 0126: X "own keys" (BYOK) plan gate in the DATABASE (defence in depth for 0123), the twin of 0125.
--
-- DRAFT for review on branch feature/whatsapp-byok (PR #115). NOT applied anywhere. Applied by hand with Werner's yes,
-- after 0123 (it reads social_accounts.credential_mode, which 0123 adds). Independent of 0124/0125: the WhatsApp trigger
-- and function are not touched and both triggers coexist on social_accounts.
--
-- Why a trigger and not a CHECK constraint. Werner wanted an explicit constraint-style error. A CHECK constraint can only
-- look at the row being written; it cannot read another table, and the plan lives in public.subscriptions. So the rule is
-- a BEFORE INSERT OR UPDATE trigger that raises an exception with its own SQLSTATE ('LRXB1') and a fixed message, which
-- the backend maps to the existing plan message. (0123's own CHECK, social_accounts_byok_x_only_check, still guarantees
-- a byok row can only be platform 'x'.)
--
-- Why. The X own-keys plan gate (Pro, shown at $59.99, and above: Pro, Business, Agency, Agency Plus) lives in the backend
-- (canUseXByok in backend/src/tier.ts, called by the X BYOK routes and the generic connect route). But 0081's RLS lets any
-- account member write social_accounts directly (insert and update policies), so a member on Free or Starter could skip
-- the backend and insert an X byok row (platform = 'x', credential_mode = 'byok'), or turn one of their own rows into one.
-- The backend gate stays; this is the backstop. It applies to every role including service_role.
--
-- The rule. Whenever NEW.platform = 'x' AND NEW.credential_mode = 'byok' and the write CREATES or CHANGES the X byok
-- state, the owning account must have a subscription with status active or trialing (the same "good standing" test as
-- resolveTier in backend/src/tier.ts) and a tier in ('pro', 'business', 'agency', 'agency_plus')
-- (X_BYOK_ALLOWED_TIERS in tier.ts; a vitest keeps the two lists equal). No subscription row, or any other status, fails
-- CLOSED (Free and Starter are blocked).
-- "Creates or changes" means: an INSERT; or an UPDATE where the row was not an X byok row before (OLD.platform <> 'x' or
-- OLD.credential_mode <> 'byok'); or an UPDATE that changes account_id or platform_account_id.
-- platform_account_id is in the list on purpose: it is the X handle. Re-pointing an existing own-keys row at a different
-- handle is re-saving keys, the same act the route refuses on a plan without the feature (the route looks a row up by
-- handle, so a different handle is a new row and an INSERT here). Nothing legitimate changes it on an existing row.
--
-- What it does NOT touch:
--   * x rows with credential_mode = 'platform' (LazyRelay's own X app, still allowed by 0123), on every plan;
--   * any other platform;
--   * ordinary maintenance of an EXISTING x byok row, so a downgrade or cancellation never strands a connection:
--     disconnected_at, the 0117 token wipe, needs_reconnect flags, paused_at, byok_status, byok_validated_at,
--     byok_key_hint, display name, brand, token columns. DELETE is not trigger-checked.
-- Note an upsert (INSERT ... ON CONFLICT DO UPDATE) runs the BEFORE INSERT trigger first, so re-saving keys through the
-- route on a downgraded plan is blocked too, which is the intent (the route blocks it earlier anyway).
--
-- Error. SQLSTATE 'LRXB1' (a class of our own, so nothing else can raise it by accident) with the message
-- 'x own keys requires the Pro plan or above'. The backend maps either to the route's existing plan message.
--
-- Function hardening, same pattern as 0003, 0055, 0088 and 0125: SECURITY DEFINER (so it can read subscriptions whatever
-- the caller's RLS says), search_path = public, pg_temp, every object schema-qualified, EXECUTE revoked from PUBLIC, anon
-- and authenticated (a trigger function is never called directly, and trigger execution does not check the caller's
-- EXECUTE right). Owner: whoever runs the migration (postgres on Supabase); do not change it, the owner must be able to
-- read subscriptions (RLS does not apply to a table owner).

begin;

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

  -- "found" is false with no subscription row; null tier or status also falls through to the exception (fail closed).
  if found
     and v_status in ('active', 'trialing')
     and v_tier in ('pro', 'business', 'agency', 'agency_plus')
  then
    return new;
  end if;

  raise exception 'x own keys requires the Pro plan or above' using errcode = 'LRXB1';
end;
$$;

revoke execute on function public.enforce_x_byok_plan_gate() from public, anon, authenticated;

drop trigger if exists social_accounts_x_byok_plan_gate on public.social_accounts;
create trigger social_accounts_x_byok_plan_gate
  before insert or update on public.social_accounts
  for each row execute function public.enforce_x_byok_plan_gate();

commit;

-- ROLLBACK (manual, in one transaction; nothing else depends on it, and 0125's trigger is not touched):
--   begin;
--   drop trigger if exists social_accounts_x_byok_plan_gate on public.social_accounts;
--   drop function if exists public.enforce_x_byok_plan_gate();
--   commit;
