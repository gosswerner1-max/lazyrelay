-- 0135: credential_audit_events, one row per change to a stored platform credential (decided by Werner 2026-10-19).
--
-- DRAFT for review on branch feature/byok-onboarding-polish. NOT applied anywhere. Apply by hand with Werner's yes, on a
-- throwaway Supabase branch first (the repo has no SQL test harness: this file has only been read and checked as text).
--
-- Why. Team members (role 'member') may save or clear a connection's credentials, the same as an owner. That stays. What was
-- missing is a record of who did it, so every credential change now writes one entry: saved (first save), replaced (a save over
-- a connection that already held a login), cleared (a BYOK connection was disconnected and its stored login destroyed) or
-- app_secret_cleared (the saved WhatsApp App Secret was removed).
--
-- What it stores: ids, the platform name, the action and the actor's role. NEVER a secret, token, key hint or request body, and
-- there is no column that could hold one.
--
-- Access: RLS on. A signed-in member of the owning account may READ their account's rows. There is no insert, update or delete
-- policy and the browser-facing roles hold no write privilege: only the backend's service-role client writes.
--
-- Idempotent (safe to apply twice) and wrapped in one transaction.
--
-- ROLLBACK (by hand; it deletes the audit trail):
--   drop table if exists public.credential_audit_events;

begin;

create table if not exists public.credential_audit_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  -- null when the connection row is not known to the caller; no foreign key, so history survives a deleted connection
  social_account_id uuid,
  platform text not null,
  action text not null check (action in ('saved', 'replaced', 'cleared', 'app_secret_cleared')),
  actor_user_id uuid,
  actor_role text,
  created_at timestamptz not null default now()
);

create index if not exists credential_audit_events_account_created_idx on public.credential_audit_events (account_id, created_at desc);

alter table public.credential_audit_events enable row level security;

drop policy if exists credential_audit_events_select_members on public.credential_audit_events;
create policy credential_audit_events_select_members on public.credential_audit_events for select to authenticated using (is_account_member(account_id));

-- Browser-facing roles: read only, through the policy above.
revoke all on public.credential_audit_events from anon, authenticated;
grant select on public.credential_audit_events to authenticated;
-- Explicit grant for the backend, because Supabase stops granting new tables to the API roles automatically on 2026-10-30.
grant all on public.credential_audit_events to service_role;

commit;
