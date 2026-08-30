-- Duplicate business names (2026-08-30, Werner) slow down support/agents
-- trying to find the right account when several customers share a common
-- name — same reasoning as brands' own per-account unique index (0047),
-- but this one is unscoped since duplicates ACROSS different accounts are
-- the actual problem here. Partial (where business_name is not null) so
-- the common "left it blank at signup" case never collides.
--
-- Safe with no backfill: verified live, exactly one account currently has
-- a business_name set at all.
create unique index accounts_lower_business_name_idx on accounts (lower(business_name)) where business_name is not null;

-- Signup has no backend route (see AuthContext.tsx's signUp) — the chosen
-- name goes straight into Supabase auth's user metadata and this trigger
-- inserts the accounts row afterward, inside the same transaction as the
-- auth.users insert. The frontend now checks name availability before
-- submitting (POST /public/signup/check-business-name), but that check and
-- this insert aren't atomic — two people could submit the identical name a
-- moment apart. If the insert above hits the new unique index, the whole
-- transaction must not fail (that would break signup itself with no
-- recovery path) — fall back to a null business_name instead. The account
-- can set a unique one afterward via PATCH /account, which enforces the
-- same constraint.
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
  return new;
end;
$$;
