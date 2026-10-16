-- 0131: two-way WhatsApp. Conversations and chat messages (encrypted at rest), approval requests, saved audiences, and the 30 day
-- retention functions (Phase 2b of the WhatsApp feature; plan: vault note 03 - LazyRelay/plan-whatsapp-broadcasts-2026-10-15.md).
--
-- DRAFT for review on branch feature/whatsapp-broadcast-send. NOT applied anywhere. Apply by hand with Werner's yes, after 0128, 0129
-- and 0130, on a throwaway Supabase branch first. The repo has no SQL test harness, so the policies, grants and functions below have
-- only been read and checked as text, never executed.
--
-- What is stored, and how:
--   * A conversation is one person talking to ONE of the customer's WhatsApp numbers. It is keyed by the same keyed, account-scoped
--     hash (contact_key) as whatsapp_contacts and whatsapp_messages, shows a mask, and keeps the person's number ONLY as an AES-256-GCM
--     envelope (phone_ciphertext, made by the backend with WHATSAPP_CONTACT_ENC_KEY, bound to the account and contact key). The
--     number has to be kept encrypted, not just hashed, because a reply cannot be sent to a hash.
--   * A chat message body is an AES-256-GCM envelope too (body_ciphertext). Meta's message id embeds the person's number, so only a
--     keyed hash of it (message_key) is kept: enough to make a repeated delivery a no-op and to match a delivery receipt or a
--     button tap back to the message it belongs to.
--   * The browser-facing roles can read every column EXCEPT the three ciphertext columns (column-level privilege, no "select *"),
--     and only for accounts they belong to. The backend (service role) decrypts for the signed-in customer, one account at a time.
--
-- UNKNOWN NUMBERS (decision for review): a person who messages the customer's number and is NOT a stored contact still gets a
-- conversation, so the customer can answer them inside Meta's 24 hour window (a customer-initiated chat). contact_id is null for
-- them. They are NEVER added to whatsapp_contacts, never counted in a broadcast audience, and never marketed to: only an opted-in
-- stored contact can receive a broadcast. Their conversation is removed 30 days after its last message like every other one.
--
-- Approval requests are a CONVENIENCE RECORD of a client's button tap (an id and a title). They are not legal consent, not a
-- signature and not proof of a contract; the screens say so in plain words.
--
-- Retention (the same 30 day default as the rest of the feature, decision D3): purge_whatsapp_chat() removes every conversation whose
-- last message is older than the cutoff (its messages and approvals go with it), and purge_whatsapp_broadcast_history() removes the
-- per-person delivery rows of finished broadcasts (the broadcast's own totals stay). Both are called by the 6 hourly privacy sweep
-- (privacySweep.ts / index.ts). Erasing a stored contact removes their conversation at once (on delete cascade).
--
-- Access: RLS on. Members read their account's rows. No insert, update or delete policies; the browser-facing roles hold no write
-- privilege. Only the backend's service role writes. Idempotent (safe to apply twice), one transaction.
--
-- ROLLBACK (by hand; it deletes every conversation, chat message, approval and saved audience):
--   begin;
--   drop function if exists purge_whatsapp_broadcast_history(timestamptz);
--   drop function if exists purge_whatsapp_chat(timestamptz);
--   drop table if exists whatsapp_audience_members;
--   drop table if exists whatsapp_audiences;
--   drop table if exists whatsapp_approval_requests;
--   drop table if exists whatsapp_chat_messages;
--   drop table if exists whatsapp_conversations;
--   commit;

begin;

create table if not exists whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  -- keyed, account-scoped hash (64 hex) of the number: the same value whatsapp_contacts and whatsapp_messages use
  contact_key text not null,
  -- masked number for display, e.g. '+27 ** *** 1111'
  contact_display text not null,
  -- the stored contact this conversation belongs to; null for a person who is not one (see the header). Erasing the contact erases this.
  contact_id uuid references whatsapp_contacts(id) on delete cascade,
  -- AES-256-GCM envelope of the E.164 number. NEVER selectable by the browser-facing roles.
  phone_ciphertext text not null,
  display_name text,
  -- when the person last wrote to this number: Meta's 24 hour customer-service window runs from here
  last_inbound_at timestamptz,
  last_message_at timestamptz not null default now(),
  unread_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_conversations_contact_key_hashed check (contact_key ~ '^[0-9a-f]{64}$'),
  constraint whatsapp_conversations_contact_display_masked check (char_length(contact_display) <= 24 and contact_display !~ '[0-9]{7}'),
  constraint whatsapp_conversations_phone_ciphertext_format check (char_length(phone_ciphertext) <= 200 and phone_ciphertext ~ '^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  constraint whatsapp_conversations_display_name_length check (display_name is null or char_length(display_name) <= 80),
  constraint whatsapp_conversations_unread_nonneg check (unread_count >= 0),
  unique (social_account_id, contact_key)
);

create index if not exists whatsapp_conversations_inbox_idx on whatsapp_conversations (account_id, social_account_id, last_message_at desc);
create index if not exists whatsapp_conversations_contact_idx on whatsapp_conversations (contact_id) where contact_id is not null;

create table if not exists whatsapp_chat_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  conversation_id uuid not null references whatsapp_conversations(id) on delete cascade,
  direction text not null,
  kind text not null,
  -- AES-256-GCM envelope of the message text (for a template send, the text as filled in). NEVER selectable by the browser-facing roles.
  body_ciphertext text not null,
  -- keyed hash (64 hex) of Meta's message id; null until Meta accepts an outgoing message
  message_key text,
  status text not null default 'received',
  -- Meta's numeric error code and a short code of ours, never Meta's message text
  error_code integer,
  failure_reason text,
  -- keyed hash of the id of the message this one answers (Meta's "context" id), e.g. the approval request a button tap belongs to
  reply_to_message_key text,
  -- the approved template an outgoing template message used
  template_name text,
  -- the LazyRelay user who sent it (plain id: no foreign key, so removing a user never edits the record)
  sent_by uuid,
  occurred_at timestamptz not null default now(),
  handed_off_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint whatsapp_chat_messages_direction_check check (direction in ('inbound', 'outbound')),
  constraint whatsapp_chat_messages_kind_check check (kind in ('text', 'interactive_buttons', 'interactive_list', 'template', 'button_reply', 'list_reply', 'unsupported')),
  constraint whatsapp_chat_messages_status_check check (status in ('received', 'handed_off', 'sent', 'delivered', 'read', 'failed')),
  constraint whatsapp_chat_messages_body_format check (char_length(body_ciphertext) <= 30000 and body_ciphertext ~ '^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  constraint whatsapp_chat_messages_message_key_hashed check (message_key is null or message_key ~ '^[0-9a-f]{64}$'),
  constraint whatsapp_chat_messages_reply_key_hashed check (reply_to_message_key is null or reply_to_message_key ~ '^[0-9a-f]{64}$'),
  constraint whatsapp_chat_messages_failure_reason_format check (failure_reason is null or failure_reason ~ '^[a-z0-9_]{1,60}$'),
  constraint whatsapp_chat_messages_template_name_format check (template_name is null or template_name ~ '^[a-z0-9_]{1,512}$')
);

-- A repeated delivery of the same message is a no-op: one row per Meta message id per account.
create unique index if not exists whatsapp_chat_messages_message_key_idx on whatsapp_chat_messages (account_id, message_key) where message_key is not null;
create index if not exists whatsapp_chat_messages_thread_idx on whatsapp_chat_messages (conversation_id, occurred_at);
create index if not exists whatsapp_chat_messages_reply_idx on whatsapp_chat_messages (account_id, reply_to_message_key) where reply_to_message_key is not null;

create table if not exists whatsapp_approval_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  conversation_id uuid not null references whatsapp_conversations(id) on delete cascade,
  -- the outgoing message that carried the buttons
  message_id uuid not null references whatsapp_chat_messages(id) on delete cascade,
  -- short label of what is being approved, as an AES-256-GCM envelope. NEVER selectable by the browser-facing roles.
  title_ciphertext text not null,
  -- [{ "id": "approve", "title": "Approve" }, ...], at most 3 (Meta's limit for reply buttons)
  options jsonb not null,
  status text not null default 'pending',
  -- the client's answer: the button id and title Meta reported (our own labels), when they tapped
  response_option_id text,
  response_title text,
  responded_at timestamptz,
  response_message_id uuid references whatsapp_chat_messages(id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_approval_requests_status_check check (status in ('pending', 'approved', 'changes_requested', 'question', 'other_reply')),
  constraint whatsapp_approval_requests_options_array check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 1 and 3),
  constraint whatsapp_approval_requests_title_format check (char_length(title_ciphertext) <= 2000 and title_ciphertext ~ '^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  constraint whatsapp_approval_requests_response_option_length check (response_option_id is null or char_length(response_option_id) <= 256),
  constraint whatsapp_approval_requests_response_title_length check (response_title is null or char_length(response_title) <= 60),
  unique (message_id)
);

create index if not exists whatsapp_approval_requests_account_idx on whatsapp_approval_requests (account_id, status, created_at desc);
create index if not exists whatsapp_approval_requests_conversation_idx on whatsapp_approval_requests (conversation_id);

create table if not exists whatsapp_audiences (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  name text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint whatsapp_audiences_name_length check (char_length(name) between 1 and 80),
  unique (social_account_id, name)
);

create table if not exists whatsapp_audience_members (
  audience_id uuid not null references whatsapp_audiences(id) on delete cascade,
  -- by id only. Erasing the contact removes the membership.
  contact_id uuid not null references whatsapp_contacts(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (audience_id, contact_id)
);

create index if not exists whatsapp_audience_members_contact_idx on whatsapp_audience_members (contact_id);

-- ---------------------------------------------------------------------------------------------------------------------
-- Access: read-only for members of the owning account (never a ciphertext column); only the backend's service role writes.
-- ---------------------------------------------------------------------------------------------------------------------
alter table whatsapp_conversations enable row level security;
alter table whatsapp_chat_messages enable row level security;
alter table whatsapp_approval_requests enable row level security;
alter table whatsapp_audiences enable row level security;
alter table whatsapp_audience_members enable row level security;

drop policy if exists whatsapp_conversations_select_members on whatsapp_conversations;
create policy whatsapp_conversations_select_members on whatsapp_conversations for select to authenticated using (is_account_member(account_id));
drop policy if exists whatsapp_chat_messages_select_members on whatsapp_chat_messages;
create policy whatsapp_chat_messages_select_members on whatsapp_chat_messages for select to authenticated using (is_account_member(account_id));
drop policy if exists whatsapp_approval_requests_select_members on whatsapp_approval_requests;
create policy whatsapp_approval_requests_select_members on whatsapp_approval_requests for select to authenticated using (is_account_member(account_id));
drop policy if exists whatsapp_audiences_select_members on whatsapp_audiences;
create policy whatsapp_audiences_select_members on whatsapp_audiences for select to authenticated using (is_account_member(account_id));
drop policy if exists whatsapp_audience_members_select_members on whatsapp_audience_members;
create policy whatsapp_audience_members_select_members on whatsapp_audience_members for select to authenticated using (is_account_member(account_id));

-- Until 2026-10-30 Supabase still grants new tables to the browser-facing roles by default; this removes everything but the SELECT below.
revoke all on whatsapp_conversations from public, anon, authenticated;
revoke all on whatsapp_chat_messages from public, anon, authenticated;
revoke all on whatsapp_approval_requests from public, anon, authenticated;
revoke all on whatsapp_audiences from public, anon, authenticated;
revoke all on whatsapp_audience_members from public, anon, authenticated;

-- A COLUMN list, so the encrypted number, message bodies and approval titles can never be selected by the browser-facing roles.
grant select (id, account_id, social_account_id, contact_key, contact_display, contact_id, display_name, last_inbound_at, last_message_at, unread_count, created_at, updated_at) on whatsapp_conversations to authenticated;
grant select (id, account_id, conversation_id, direction, kind, message_key, status, error_code, failure_reason, reply_to_message_key, template_name, sent_by, occurred_at, handed_off_at, sent_at, delivered_at, read_at, failed_at, created_at) on whatsapp_chat_messages to authenticated;
grant select (id, account_id, conversation_id, message_id, options, status, response_option_id, response_title, responded_at, response_message_id, created_by, created_at, updated_at) on whatsapp_approval_requests to authenticated;
grant select on whatsapp_audiences to authenticated;
grant select on whatsapp_audience_members to authenticated;

-- Explicit grants for the backend (Supabase stops granting new tables to the API roles automatically on 2026-10-30).
grant all on whatsapp_conversations to service_role;
grant all on whatsapp_chat_messages to service_role;
grant all on whatsapp_approval_requests to service_role;
grant all on whatsapp_audiences to service_role;
grant all on whatsapp_audience_members to service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- Retention: 30 days by default. Called by the 6 hourly privacy sweep with a cutoff 30 days back.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function purge_whatsapp_chat(p_cutoff timestamptz)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  -- the conversation goes, and its messages and approval requests with it (on delete cascade)
  delete from whatsapp_conversations where last_message_at < p_cutoff;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function purge_whatsapp_chat(timestamptz) from public, anon, authenticated;
grant execute on function purge_whatsapp_chat(timestamptz) to service_role;

-- The per-person delivery rows of a broadcast that has finished (or was cancelled or failed). The broadcast's own totals stay.
create or replace function purge_whatsapp_broadcast_history(p_cutoff timestamptz)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  delete from whatsapp_broadcast_recipients r
   using whatsapp_broadcasts b
   where b.id = r.broadcast_id
     and b.status in ('completed', 'cancelled', 'failed')
     and r.updated_at < p_cutoff;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function purge_whatsapp_broadcast_history(timestamptz) from public, anon, authenticated;
grant execute on function purge_whatsapp_broadcast_history(timestamptz) to service_role;

commit;
