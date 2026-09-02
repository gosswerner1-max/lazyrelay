-- Referral/partner program, v1 (Werner's build-vs-buy call, 2026-09-02: build
-- in-house). Deliberately narrow scope for a first version -- see
-- werner-brain vault, project-referral-program-spec-2026-09-02.md, for the
-- full mechanics and the open decisions this migration reflects:
--   - Payout is manual (Werner reads a report and pays by hand) -- no
--     payout automation, no partner-facing dashboard yet.
--   - No self-serve application -- Werner invites partners by hand, so
--     every row here is created directly rather than through a public form.
--   - 30% lifetime commission, 30-day attribution, 30-day refund hold are
--     all enforced at report-generation time (see ops/marketing/referral_report.js),
--     not in the schema itself.
create table referral_partners (
  id uuid primary key default uuid_generate_v4(),
  code text not null unique,
  name text not null,
  email text not null,
  commission_rate numeric not null default 30, -- percent; a per-partner override is possible later without a schema change
  status text not null default 'approved' check (status in ('approved', 'paused')),
  -- Running total of what's already been paid out by hand (payout is manual
  -- for v1 -- see the spec). A single counter rather than a full payout
  -- ledger table: the report script computes lifetime commission owed and
  -- subtracts this to get what's due now, and referral_report.js --mark-paid
  -- is the only thing that increments it, so there's one place double-
  -- counting could be introduced, not a join across a growing ledger.
  total_paid_out numeric not null default 0,
  created_at timestamptz not null default now()
);

-- Case-insensitive code lookups (the signup capture lowercases before
-- storing, but a partner's own link could be shared with mixed case).
create unique index referral_partners_code_lower_idx on referral_partners (lower(code));

alter table referral_partners enable row level security;
-- No policies -- service-role only, same reasoning as billing_records: this
-- is an internal/partner-management table, never read by an authenticated
-- customer directly.

-- Which partner (if any) referred this account, and when the referral was
-- captured -- captured_at is what the 30-day attribution window in the
-- report script measures from, independent of when the account actually
-- converts to a paying customer.
alter table accounts add column referred_by_code text references referral_partners(code) on delete set null;
alter table accounts add column referred_at timestamptz;

create index accounts_referred_by_code_idx on accounts(referred_by_code) where referred_by_code is not null;

-- handle_new_user() picks up referred_by_code the same way it already picks
-- up business_name (both ride in Supabase's raw_user_meta_data, set by
-- AuthContext.tsx's signUp() call) -- see 0074_business_name_unique.sql and
-- 0078_fix_signup_account_members.sql for the two most recent versions of
-- this function. Only sets referred_at when a code is actually present, so
-- a normal signup with no referral leaves both columns null.
--
-- The referral code is looked up against real referral_partners rows FIRST,
-- rather than trusting client-supplied metadata straight into the
-- referred_by_code FK: an invalid, typo'd, or since-removed code hitting the
-- foreign key at insert time would fail the whole insert and block signup
-- itself, which must never happen over an unverified referral code. An
-- unrecognized code is silently dropped (signup proceeds with no
-- attribution) rather than surfaced as an error to the signing-up customer,
-- who has no way to fix someone else's stale link anyway.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_name text := new.raw_user_meta_data ->> 'business_name';
  ref_code text := lower(nullif(trim(new.raw_user_meta_data ->> 'referred_by_code'), ''));
  valid_ref_code text;
begin
  if ref_code is not null then
    select code into valid_ref_code from public.referral_partners where lower(code) = ref_code and status = 'approved';
  end if;

  begin
    insert into public.accounts (id, email, business_name, referred_by_code, referred_at)
    values (new.id, new.email, requested_name, valid_ref_code, case when valid_ref_code is not null then now() else null end);
  exception when unique_violation then
    insert into public.accounts (id, email, business_name, referred_by_code, referred_at)
    values (new.id, new.email, null, valid_ref_code, case when valid_ref_code is not null then now() else null end);
  end;
  insert into public.account_members (account_id, user_id, role, accepted_at)
  values (new.id, new.id, 'owner', now());
  return new;
end;
$$;
