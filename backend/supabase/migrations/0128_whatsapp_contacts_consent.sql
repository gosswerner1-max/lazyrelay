-- 0128: WhatsApp broadcast contacts, consent evidence and the opt-out suppression list (Phase 1 of the scheduled-broadcast
-- feature, approved by Werner 2026-10-15; plan: vault note 03 - LazyRelay/plan-whatsapp-broadcasts-2026-10-15.md).
--
-- DRAFT for review on branch feature/whatsapp-contacts-consent. NOT applied anywhere. Phase 1 stores contacts and consent
-- only: nothing here sends a message or calls Meta. Apply by hand with Werner's yes, on a throwaway Supabase branch first
-- (the repo has no SQL test harness, so the triggers and policies below have only been read, not executed).
--
-- Privacy (decision D1, 2026-10-15; narrows the 2026-10-10 rule "masked or hashed in all our tables"):
--   * A contact the customer UPLOADS for broadcasts is the one place a phone number may be stored, and only encrypted:
--     phone_ciphertext holds an AES-256-GCM envelope (v1.<keyid>.<iv>.<tag>.<ct>) made by the backend with a key that never
--     reaches the database (WHATSAPP_CONTACT_ENC_KEY). The format check below makes the database refuse plain text.
--   * Browser-facing roles can read every contacts column EXCEPT phone_ciphertext (column-level privilege, no "select *"),
--     and only for accounts they belong to (row level security). The backend's service role is the only writer.
--   * contact_key is the same keyed, account-scoped hash as whatsapp_messages (HMAC with WHATSAPP_CONTACT_HASH_KEY), so a
--     reply can be matched to a contact; contact_display is a mask such as '+27 ** *** 1111' (same check as 0127).
--
-- Consent evidence (whatsapp_opt_ins) is APPEND-ONLY and hash chained: each row stores the hash of the one before it for the
-- same contact (prev_hash, genesis = 64 zeros) and its own row_hash, computed by the backend over the row's fields, so an edit
-- or a removed row is detectable. No role holds UPDATE or DELETE on it; a trigger refuses both (and TRUNCATE). The one
-- allowed delete is the cascade from erasing the contact (or its account): by then the parent contact row is gone, which the
-- trigger checks. A separate retention/purge function is a later phase.
--
-- Opt-outs (whatsapp_opt_outs) are hash-only and permanent: they hold no phone number, no name and NO link to a contact row,
-- so they survive erasing the contact and a re-import can never subscribe the person again:
--   * after an opt-out is inserted, every matching contact of the account (by contact_key or wa_contact_key) flips to opted_out;
--   * before a contact is inserted or updated, it is forced to opted_out if a matching opt-out exists. Any scope blocks (every
--     contact here exists for marketing, so a 'marketing' opt-out must block as much as an 'all' one).
--
-- Access: RLS on. Members read their account's rows. No insert, update or delete policies; the browser-facing roles hold no
-- write privilege. Idempotent (safe to apply twice), one transaction.
--
-- ROLLBACK (by hand; it deletes every stored contact, consent record and opt-out):
--   begin;
--   drop trigger if exists whatsapp_contacts_enforce_opt_out on whatsapp_contacts;
--   drop trigger if exists whatsapp_opt_outs_apply on whatsapp_opt_outs;
--   drop trigger if exists whatsapp_opt_ins_append_only on whatsapp_opt_ins;
--   drop trigger if exists whatsapp_opt_ins_no_truncate on whatsapp_opt_ins;
--   drop function if exists whatsapp_contacts_enforce_opt_out();
--   drop function if exists whatsapp_opt_outs_apply();
--   drop function if exists whatsapp_opt_ins_append_only();
--   drop table if exists whatsapp_opt_outs;
--   drop table if exists whatsapp_opt_ins;
--   drop table if exists whatsapp_contacts;
--   commit;
-- (Dropping whatsapp_opt_ins needs the guard trigger gone first, as above; the table drop itself is not a row delete.)

begin;

create table if not exists whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  -- keyed, account-scoped hash (64 hex characters) of the number: the same value whatsapp_messages.contact_key uses
  contact_key text not null,
  -- keyed hash of the wa_id as Meta reports it, filled when it differs from the number the customer uploaded (inbound match)
  wa_contact_key text,
  -- masked number for display, e.g. '+27 ** *** 1111'
  contact_display text not null,
  -- AES-256-GCM envelope of the E.164 number (see header). NEVER selectable by the browser-facing roles.
  phone_ciphertext text,
  country_calling_code text,
  display_name text,
  consent_status text not null default 'opted_in',
  opted_in_at timestamptz,
  opted_out_at timestamptz,
  -- the whatsapp_opt_ins row that is the current consent evidence (plain id: the two tables reference each other)
  current_opt_in_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_contacts_contact_key_hashed check (contact_key ~ '^[0-9a-f]{64}$'),
  constraint whatsapp_contacts_wa_contact_key_hashed check (wa_contact_key is null or wa_contact_key ~ '^[0-9a-f]{64}$'),
  constraint whatsapp_contacts_contact_display_masked check (char_length(contact_display) <= 24 and contact_display !~ '[0-9]{7}'),
  constraint whatsapp_contacts_phone_ciphertext_format check (phone_ciphertext is null or (char_length(phone_ciphertext) <= 200 and phone_ciphertext ~ '^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')),
  constraint whatsapp_contacts_country_calling_code_format check (country_calling_code is null or country_calling_code ~ '^[0-9]{1,3}$'),
  constraint whatsapp_contacts_display_name_length check (display_name is null or char_length(display_name) <= 80),
  constraint whatsapp_contacts_consent_status_check check (consent_status in ('opted_in', 'opted_out')),
  constraint whatsapp_contacts_opted_in_has_date check (consent_status <> 'opted_in' or opted_in_at is not null),
  constraint whatsapp_contacts_social_contact_key unique (social_account_id, contact_key)
);

create index if not exists whatsapp_contacts_account_status_idx on whatsapp_contacts (account_id, consent_status);
create index if not exists whatsapp_contacts_account_key_idx on whatsapp_contacts (account_id, contact_key);
create index if not exists whatsapp_contacts_account_wa_key_idx on whatsapp_contacts (account_id, wa_contact_key) where wa_contact_key is not null;

create table if not exists whatsapp_opt_ins (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  contact_id uuid not null references whatsapp_contacts(id) on delete cascade,
  source text not null,
  -- when the person gave consent (as the customer states it); never later than when we recorded it
  captured_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  -- the LazyRelay user who recorded it (plain id: no foreign key, so removing a user never edits evidence)
  recorded_by uuid,
  consent_text text not null,
  proof_reference text,
  attested boolean not null,
  attestation_version text not null,
  import_batch_id uuid,
  -- hash chain, per contact: prev_hash is the previous row's row_hash (64 zeros for the first); row_hash is SHA-256 over this row
  prev_hash text not null,
  row_hash text not null,
  constraint whatsapp_opt_ins_source_check check (source in ('customer_import', 'website_form', 'whatsapp_inbound', 'click_to_whatsapp_ad', 'in_person', 'phone_call', 'qr_code', 'other')),
  constraint whatsapp_opt_ins_attested_check check (attested),
  constraint whatsapp_opt_ins_captured_not_future check (captured_at <= recorded_at),
  constraint whatsapp_opt_ins_consent_text_length check (char_length(consent_text) between 1 and 1000),
  constraint whatsapp_opt_ins_proof_reference_length check (proof_reference is null or char_length(proof_reference) <= 500),
  constraint whatsapp_opt_ins_attestation_version_length check (char_length(attestation_version) between 1 and 40),
  constraint whatsapp_opt_ins_prev_hash_format check (prev_hash ~ '^[0-9a-f]{64}$'),
  constraint whatsapp_opt_ins_row_hash_format check (row_hash ~ '^[0-9a-f]{64}$'),
  -- the chain cannot fork: one row per (contact, previous hash)
  constraint whatsapp_opt_ins_chain_unique unique (contact_id, prev_hash)
);

create index if not exists whatsapp_opt_ins_contact_idx on whatsapp_opt_ins (contact_id, recorded_at);
create index if not exists whatsapp_opt_ins_account_idx on whatsapp_opt_ins (account_id);

create table if not exists whatsapp_opt_outs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  contact_key text not null,
  contact_display text not null,
  wa_contact_key text,
  scope text not null default 'all',
  source text not null,
  keyword text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint whatsapp_opt_outs_contact_key_hashed check (contact_key ~ '^[0-9a-f]{64}$'),
  constraint whatsapp_opt_outs_wa_contact_key_hashed check (wa_contact_key is null or wa_contact_key ~ '^[0-9a-f]{64}$'),
  constraint whatsapp_opt_outs_contact_display_masked check (char_length(contact_display) <= 24 and contact_display !~ '[0-9]{7}'),
  constraint whatsapp_opt_outs_scope_check check (scope in ('all', 'marketing')),
  constraint whatsapp_opt_outs_source_check check (source in ('keyword', 'meta_131050', 'manual', 'import_row')),
  constraint whatsapp_opt_outs_keyword_length check (keyword is null or char_length(keyword) <= 20),
  constraint whatsapp_opt_outs_account_key_scope unique (account_id, contact_key, scope)
);

create index if not exists whatsapp_opt_outs_account_wa_key_idx on whatsapp_opt_outs (account_id, wa_contact_key) where wa_contact_key is not null;

-- ---------------------------------------------------------------------------------------------------------------------
-- Access: read-only for members of the owning account; only the backend's service role writes.
-- ---------------------------------------------------------------------------------------------------------------------
alter table whatsapp_contacts enable row level security;
alter table whatsapp_opt_ins enable row level security;
alter table whatsapp_opt_outs enable row level security;

drop policy if exists whatsapp_contacts_select_members on whatsapp_contacts;
create policy whatsapp_contacts_select_members on whatsapp_contacts for select to authenticated using (is_account_member(account_id));
drop policy if exists whatsapp_opt_ins_select_members on whatsapp_opt_ins;
create policy whatsapp_opt_ins_select_members on whatsapp_opt_ins for select to authenticated using (is_account_member(account_id));
drop policy if exists whatsapp_opt_outs_select_members on whatsapp_opt_outs;
create policy whatsapp_opt_outs_select_members on whatsapp_opt_outs for select to authenticated using (is_account_member(account_id));

-- Browser-facing roles: read only. (Until 2026-10-30 Supabase still grants new tables to these roles by default; this removes
-- everything but the SELECT below.) whatsapp_contacts gets a COLUMN list so phone_ciphertext can never be selected by them.
revoke all on whatsapp_contacts from public, anon, authenticated;
revoke all on whatsapp_opt_ins from public, anon, authenticated;
revoke all on whatsapp_opt_outs from public, anon, authenticated;

grant select (id, account_id, social_account_id, contact_key, wa_contact_key, contact_display, country_calling_code, display_name, consent_status, opted_in_at, opted_out_at, current_opt_in_id, created_at, updated_at) on whatsapp_contacts to authenticated;
grant select on whatsapp_opt_ins to authenticated;
grant select on whatsapp_opt_outs to authenticated;

-- Explicit grants for the backend (Supabase stops granting new tables to the API roles automatically on 2026-10-30).
-- Consent evidence and the suppression list are insert-only even for the backend: no UPDATE, DELETE or TRUNCATE.
grant all on whatsapp_contacts to service_role;
grant select, insert on whatsapp_opt_ins to service_role;
grant select, insert on whatsapp_opt_outs to service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- Consent evidence is append-only.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function whatsapp_opt_ins_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'whatsapp_opt_ins is append-only' using errcode = 'LRWC1';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'whatsapp_opt_ins is append-only' using errcode = 'LRWC1';
  end if;
  -- DELETE: allowed only when the parent contact is already gone (the cascade from erasing a contact or an account).
  if exists (select 1 from whatsapp_contacts c where c.id = old.contact_id) then
    raise exception 'whatsapp_opt_ins is append-only' using errcode = 'LRWC1';
  end if;
  return old;
end;
$$;

revoke execute on function whatsapp_opt_ins_append_only() from public, anon, authenticated;

drop trigger if exists whatsapp_opt_ins_append_only on whatsapp_opt_ins;
create trigger whatsapp_opt_ins_append_only
  before update or delete on whatsapp_opt_ins
  for each row execute function whatsapp_opt_ins_append_only();

drop trigger if exists whatsapp_opt_ins_no_truncate on whatsapp_opt_ins;
create trigger whatsapp_opt_ins_no_truncate
  before truncate on whatsapp_opt_ins
  for each statement execute function whatsapp_opt_ins_append_only();

-- ---------------------------------------------------------------------------------------------------------------------
-- Opt-outs always win.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function whatsapp_opt_outs_apply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update whatsapp_contacts c
     set consent_status = 'opted_out',
         opted_out_at = coalesce(c.opted_out_at, new.occurred_at),
         updated_at = now()
   where c.account_id = new.account_id
     and c.consent_status <> 'opted_out'
     and (c.contact_key = new.contact_key
          or c.wa_contact_key = new.contact_key
          or (new.wa_contact_key is not null and (c.contact_key = new.wa_contact_key or c.wa_contact_key = new.wa_contact_key)));
  return new;
end;
$$;

revoke execute on function whatsapp_opt_outs_apply() from public, anon, authenticated;

drop trigger if exists whatsapp_opt_outs_apply on whatsapp_opt_outs;
create trigger whatsapp_opt_outs_apply
  after insert on whatsapp_opt_outs
  for each row execute function whatsapp_opt_outs_apply();

create or replace function whatsapp_contacts_enforce_opt_out()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.consent_status <> 'opted_out'
     and exists (
       select 1
         from whatsapp_opt_outs o
        where o.account_id = new.account_id
          and (o.contact_key = new.contact_key
               or o.wa_contact_key = new.contact_key
               or (new.wa_contact_key is not null and (o.contact_key = new.wa_contact_key or o.wa_contact_key = new.wa_contact_key)))
     ) then
    new.consent_status := 'opted_out';
    new.opted_out_at := coalesce(new.opted_out_at, now());
  end if;
  return new;
end;
$$;

revoke execute on function whatsapp_contacts_enforce_opt_out() from public, anon, authenticated;

drop trigger if exists whatsapp_contacts_enforce_opt_out on whatsapp_contacts;
create trigger whatsapp_contacts_enforce_opt_out
  before insert or update on whatsapp_contacts
  for each row execute function whatsapp_contacts_enforce_opt_out();

commit;
