-- 0137: credential_audit_events learns two system events, rejected and recovered (decided by the owner 2026-10-19).
--
-- DRAFT for review on branch feature/stage3-self-healing. NOT applied anywhere. Apply by hand with the owner's yes, on a throwaway
-- Supabase branch first (the repo has no SQL test harness: this file has only been read and checked as text). Needs 0135 first.
--
-- Why. 0135 records who changed a stored credential. This adds what the SYSTEM saw happen to a connection: it went from working to
-- refused (rejected) and later came back (recovered). Only transitions are written, only for auth-class refusals, never for network,
-- DNS, timeout or 5xx errors. The backend does this only while SELF_HEALING_MODE is shadow or on.
--
-- What changes:
--   1. The action check also accepts 'rejected' and 'recovered' (dropped and re-added; the four old values are unchanged).
--   2. A nullable reason_code column with a check against a fixed list. Only a fixed code, never text from a platform.
--   3. Function record_system_credential_audit(): ONE insert ... select ... where not exists statement, so there is at most one row per
--      (social_account_id, action) per 24 hours. A per-connection advisory lock makes two concurrent writers take turns. The row has a
--      null actor_user_id and actor_role 'system' (both columns were already nullable and unchecked, so nothing changes for them).
--   4. Execute is granted to the backend service role only.
--
-- Access to the table is unchanged: members of the owning account may read their rows, nothing in the browser can write.
--
-- Idempotent (safe to apply twice) and wrapped in one transaction.
--
-- ROLLBACK (by hand; delete the system rows first or the old check will refuse):
--   delete from public.credential_audit_events where action in ('rejected', 'recovered');
--   drop function if exists public.record_system_credential_audit(uuid, uuid, text, text, text);
--   drop index if exists public.credential_audit_events_sa_action_created_idx;
--   alter table public.credential_audit_events drop constraint if exists credential_audit_events_reason_code_check;
--   alter table public.credential_audit_events drop column if exists reason_code;
--   alter table public.credential_audit_events drop constraint if exists credential_audit_events_action_check;
--   alter table public.credential_audit_events add constraint credential_audit_events_action_check check (action in ('saved', 'replaced', 'cleared', 'app_secret_cleared'));

begin;

alter table public.credential_audit_events drop constraint if exists credential_audit_events_action_check;
alter table public.credential_audit_events add constraint credential_audit_events_action_check check (action in ('saved', 'replaced', 'cleared', 'app_secret_cleared', 'rejected', 'recovered'));

alter table public.credential_audit_events add column if not exists reason_code text;
alter table public.credential_audit_events drop constraint if exists credential_audit_events_reason_code_check;
alter table public.credential_audit_events add constraint credential_audit_events_reason_code_check check (reason_code is null or reason_code in ('invalid_token', 'expired', 'revoked', 'insufficient_permission', 'key_rejected', 'validation_failed'));

-- Serves the 24 hour duplicate check below.
create index if not exists credential_audit_events_sa_action_created_idx on public.credential_audit_events (social_account_id, action, created_at desc);

create or replace function public.record_system_credential_audit(
  p_account_id uuid,
  p_social_account_id uuid,
  p_platform text,
  p_action text,
  p_reason_code text
) returns boolean
language plpgsql
set search_path = public
as $$
declare
  inserted integer;
begin
  if p_action not in ('rejected', 'recovered') then
    raise exception 'record_system_credential_audit only writes rejected or recovered';
  end if;
  if p_social_account_id is null then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_social_account_id::text || ':' || p_action, 0));
  insert into public.credential_audit_events (account_id, social_account_id, platform, action, actor_user_id, actor_role, reason_code)
  select p_account_id, p_social_account_id, p_platform, p_action, null, 'system', p_reason_code
  where not exists (
    select 1 from public.credential_audit_events e
    where e.social_account_id = p_social_account_id and e.action = p_action and e.created_at > now() - interval '24 hours'
  );
  get diagnostics inserted = row_count;
  return inserted > 0;
end;
$$;

revoke all on function public.record_system_credential_audit(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.record_system_credential_audit(uuid, uuid, text, text, text) to service_role;

commit;
