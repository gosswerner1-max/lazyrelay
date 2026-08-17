-- Agency tier v1: lets more than one person act on one account.
-- accounts.id stays a direct FK to auth.users(id) (see 0001_init_schema.sql)
-- -- unchanged, so every existing solo customer needs zero migration of
-- their own data. This table is the added indirection layer: it maps
-- people (auth.users) to the account(s) they can act on, with a role.
--
-- v1 is deliberately narrow: two roles (owner/member), and a person can be
-- an accepted member of at most one OTHER account beyond their own (see
-- resolveAccountForUser() in auth.ts) -- no account-switcher UI, no
-- multi-account membership. That covers "agency owner + their staff on one
-- shared login," not "freelancer managing several separate clients'
-- accounts," which is left for a later pass if it's ever needed.
create table account_members (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  -- Null until the invited person actually has a LazyRelay login to attach
  -- to -- see invited_email below for how a pending invite is represented
  -- before that happens.
  user_id uuid references auth.users(id) on delete cascade,
  -- Set only while the invite is pending (user_id is null); cleared to null
  -- implicitly irrelevant once user_id is filled in on acceptance -- the
  -- row is looked up by invite_token at that point, not by this column.
  invited_email text,
  role text not null check (role in ('owner', 'member')),
  invite_token uuid not null default uuid_generate_v4(),
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  check (user_id is not null or invited_email is not null)
);

-- Partial (not plain) unique indexes: user_id/invited_email are each null
-- half the time (pending invite vs accepted membership), and a plain
-- multi-column unique index would let unlimited nulls through anyway, so
-- being explicit here documents the intent rather than relying on that.
create unique index account_members_account_user_idx on account_members (account_id, user_id) where user_id is not null;
create unique index account_members_account_email_idx on account_members (account_id, lower(invited_email)) where invited_email is not null;
create index account_members_user_id_idx on account_members (user_id);
create index account_members_account_id_idx on account_members (account_id);
create unique index account_members_invite_token_idx on account_members (invite_token);

alter table account_members enable row level security;

-- Defense-in-depth only, matching the rest of this schema -- the live
-- enforcement path is the Express backend on the service-role key
-- (requireAuth/requireRole in auth.ts), since the frontend never queries
-- Supabase tables directly. See accounts_select_own etc. in 0001 for the
-- same pattern.
create policy "account_members_select_own_membership" on account_members
  for select using (auth.uid() = user_id);

create policy "account_members_select_as_account_owner" on account_members
  for select using (auth.uid() = account_id);

-- Backfill: every existing account gets a self-owner row, so today's
-- solo-customer resolution path (one user, their own account) is
-- unchanged after this migration -- see resolveAccountForUser() in auth.ts.
insert into account_members (account_id, user_id, role, accepted_at)
select id, id, 'owner', created_at from accounts
on conflict (account_id, user_id) where user_id is not null do nothing;

-- New signups also need their own owner row from the moment they sign up,
-- not just accounts backfilled above -- otherwise every account created
-- after this migration would resolve to zero memberships and be locked
-- out. Same trigger as 0005_account_on_signup.sql, extended in place.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.accounts (id, email)
  values (new.id, new.email);
  insert into public.account_members (account_id, user_id, role, accepted_at)
  values (new.id, new.id, 'owner', now());
  return new;
end;
$$;
