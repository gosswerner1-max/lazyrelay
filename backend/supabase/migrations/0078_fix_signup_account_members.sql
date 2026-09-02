-- Fixes a real regression introduced by 0074_business_name_unique.sql: its
-- `create or replace function handle_new_user()` rewrote the signup trigger
-- to add business-name unique-violation handling, but in doing so silently
-- dropped the `insert into public.account_members (...)` line that
-- 0053_account_members.sql had added. Since 0074 was deployed (2026-08-30),
-- every fresh signup got an `accounts` row but no owner `account_members`
-- row, so resolveAccountForUser() in auth.ts always returned null and every
-- new signup hit "This account has no active membership. Contact support."
-- on their very first login -- a completely broken account from the start.
--
-- Found live 2026-09-02 when Werner's own test signup (created to verify
-- the free-tier MCP change) hit exactly this wall. Confirmed against the
-- real database: of the only 2 accounts that exist in production, the one
-- created before 0074 has its account_members row; the one created after
-- does not. Zero real paying customers were affected -- this test signup
-- was the first one since the regression landed.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_name text := new.raw_user_meta_data ->> 'business_name';
begin
  begin
    insert into public.accounts (id, email, business_name)
    values (new.id, new.email, requested_name);
  exception when unique_violation then
    insert into public.accounts (id, email, business_name)
    values (new.id, new.email, null);
  end;
  insert into public.account_members (account_id, user_id, role, accepted_at)
  values (new.id, new.id, 'owner', now());
  return new;
end;
$$;

-- Backfill: any account created while the regression was live (2026-08-30
-- onward) and still missing its owner row gets one now, same shape as
-- 0053's original backfill -- so this isn't just a fix for future signups.
insert into account_members (account_id, user_id, role, accepted_at)
select id, id, 'owner', created_at from accounts
on conflict (account_id, user_id) where user_id is not null do nothing;
