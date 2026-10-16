-- 0129: WhatsApp message templates (synced from the customer's own Meta account) and the customer's own rate card
-- (Phase 2 of the scheduled-broadcast feature; plan: vault note 03 - LazyRelay/plan-whatsapp-broadcasts-2026-10-15.md).
--
-- DRAFT for review on branch feature/whatsapp-broadcast-send. NOT applied anywhere. Run it on a throwaway Supabase branch first
-- (the repo has no SQL test harness, so the policies and grants below have only been read, not executed).
--
-- Why templates: a scheduled send is outside WhatsApp's 24 hour customer-service window, so Meta only accepts an APPROVED message
-- template. The backend copies the customer's templates from THEIR Meta account (read with their own token) into this table so a
-- broadcast can name one. Only the template's text, language, category and status are kept: no phone number, no customer data.
-- A template whose header needs a media file, or whose header or button needs a variable, is stored with supported = false and a
-- reason, and can never be chosen for a broadcast (this version sends body variables only).
--
-- Why a rate card: Meta bills the customer directly, per delivered message, by category. A delivery webhook says the category and
-- whether it was billable, never the money. So the cost LazyRelay shows is an ESTIMATE: delivered messages times the price the
-- customer typed in here. The prices are the customer's own numbers; nothing here comes from Meta.
--
-- Access: RLS on. Members read their account's rows. No insert, update or delete policies; the browser-facing roles hold no write
-- privilege. Only the backend's service role writes. Idempotent (safe to apply twice), one transaction.
--
-- ROLLBACK (by hand; it deletes every stored template and rate card, nothing else):
--   begin;
--   drop table if exists whatsapp_rate_cards;
--   drop table if exists whatsapp_message_templates;
--   commit;

begin;

create table if not exists whatsapp_message_templates (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  -- Meta's own id for the template (a numeric string)
  meta_template_id text not null,
  name text not null,
  language text not null,
  category text not null,
  status text not null,
  -- the BODY text with its {{1}} style placeholders, as Meta returned it
  body_text text not null default '',
  -- how many body variables ({{1}} .. {{n}}) a send must fill
  variable_count integer not null default 0,
  -- false when this version cannot send it (media header, header or button variables); see unsupported_reason
  supported boolean not null default true,
  unsupported_reason text,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_message_templates_meta_id_format check (meta_template_id ~ '^[0-9]{1,30}$'),
  constraint whatsapp_message_templates_name_format check (char_length(name) between 1 and 512 and name ~ '^[a-z0-9_]+$'),
  constraint whatsapp_message_templates_language_format check (language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  constraint whatsapp_message_templates_category_check check (category in ('marketing', 'utility', 'authentication')),
  constraint whatsapp_message_templates_status_check check (status in ('approved', 'pending', 'rejected', 'paused', 'disabled', 'in_appeal', 'other')),
  constraint whatsapp_message_templates_body_length check (char_length(body_text) <= 1024),
  constraint whatsapp_message_templates_variable_count check (variable_count between 0 and 20),
  constraint whatsapp_message_templates_unsupported_reason_length check (unsupported_reason is null or char_length(unsupported_reason) <= 200),
  constraint whatsapp_message_templates_connection_name_language unique (social_account_id, name, language)
);

create index if not exists whatsapp_message_templates_account_idx on whatsapp_message_templates (account_id, social_account_id);

create table if not exists whatsapp_rate_cards (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  -- ISO 4217 code of the currency the customer is billed in, typed by the customer
  currency text not null,
  marketing_per_message numeric(12, 6) not null default 0,
  utility_per_message numeric(12, 6) not null default 0,
  authentication_per_message numeric(12, 6) not null default 0,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint whatsapp_rate_cards_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint whatsapp_rate_cards_marketing_nonneg check (marketing_per_message >= 0 and marketing_per_message <= 1000),
  constraint whatsapp_rate_cards_utility_nonneg check (utility_per_message >= 0 and utility_per_message <= 1000),
  constraint whatsapp_rate_cards_authentication_nonneg check (authentication_per_message >= 0 and authentication_per_message <= 1000),
  unique (social_account_id)
);

-- ---------------------------------------------------------------------------------------------------------------------
-- Access: read-only for members of the owning account; only the backend's service role writes.
-- ---------------------------------------------------------------------------------------------------------------------
alter table whatsapp_message_templates enable row level security;
alter table whatsapp_rate_cards enable row level security;

drop policy if exists whatsapp_message_templates_select_members on whatsapp_message_templates;
create policy whatsapp_message_templates_select_members on whatsapp_message_templates for select to authenticated using (is_account_member(account_id));
drop policy if exists whatsapp_rate_cards_select_members on whatsapp_rate_cards;
create policy whatsapp_rate_cards_select_members on whatsapp_rate_cards for select to authenticated using (is_account_member(account_id));

-- Until 2026-10-30 Supabase still grants new tables to the browser-facing roles by default; this removes everything but SELECT.
revoke all on whatsapp_message_templates from public, anon, authenticated;
revoke all on whatsapp_rate_cards from public, anon, authenticated;

grant select on whatsapp_message_templates to authenticated;
grant select on whatsapp_rate_cards to authenticated;

-- Explicit grants for the backend (Supabase stops granting new tables to the API roles automatically on 2026-10-30).
grant all on whatsapp_message_templates to service_role;
grant all on whatsapp_rate_cards to service_role;

commit;
