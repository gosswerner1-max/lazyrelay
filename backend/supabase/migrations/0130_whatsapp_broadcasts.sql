-- 0130: WhatsApp broadcasts, their recipients, delivery status events, send controls (kill switch and caps), the per-connection
-- pause state, and the function that claims recipients (Phase 2 of the scheduled-broadcast feature; plan: vault note
-- 03 - LazyRelay/plan-whatsapp-broadcasts-2026-10-15.md).
--
-- DRAFT for review on branch feature/whatsapp-broadcast-send. NOT applied anywhere. Apply by hand with Werner's yes, after 0128 and
-- 0129, on a throwaway Supabase branch first. The repo has no SQL test harness, so the triggers, policies and the claim function
-- below have only been read and checked as text, never executed.
--
-- What a broadcast is: one approved template, sent to the opted-in contacts of ONE of the customer's WhatsApp connections, at a
-- scheduled time, with the customer's OWN Meta token. A "recipient" row is one contact in one broadcast. It points at the contact
-- by id and holds NO phone number: the encrypted number stays in whatsapp_contacts (0128) and is read only by the backend at the
-- moment of sending. Meta's message id embeds the recipient's number, so only a keyed hash of it (message_key) is kept, which is
-- enough to match a delivery receipt back to its recipient.
--
-- Status meanings (recipients): queued -> claimed (a sender holds it) -> handed_off (Meta accepted it and returned a message id;
-- this is "posted", NOT "delivered") -> sent -> delivered -> read, or failed, or skipped (never attempted: opted out, a US number
-- for a marketing template, cancelled). Delivery is shown to the customer only from Meta's own receipts.
--
-- Safety, in the database:
--   * claim_whatsapp_broadcast_recipients() claims recipients and checks consent and opt-outs in ONE function, row-locked and
--     skip-locked, so two senders never take the same recipient and an opted-out contact is skipped instead of claimed. The
--     backend checks again right before each send (the second layer); this is the first.
--   * whatsapp_broadcast_status_events is APPEND-ONLY (update, delete and truncate refused by trigger, no role holds the
--     privilege), idempotent by event_key because Meta re-delivers receipts for up to 7 days.
--   * whatsapp_send_controls holds the kill switch and the caps. The global row is seeded STOPPED (kill_switch = true): nothing
--     can send until a person flips it. If the row is missing the backend refuses to send.
--
-- PLACEHOLDER NUMBERS. The caps seeded below (500 recipients per broadcast, 2 broadcasts per day, 250 messages per rolling 24
-- hours) are NOT decisions. They are conservative placeholders until Werner sets the plan caps (decision D4 in the plan note).
-- 250 matches Meta's lowest messaging-limit tier. Change the row, not the code.
--
-- Access: RLS on. Members read their account's rows. No insert, update or delete policies; the browser-facing roles hold no write
-- privilege. Only the backend's service role writes. Idempotent (safe to apply twice), one transaction.
--
-- ROLLBACK (by hand; it deletes every broadcast, recipient, status event, control row and pause state):
--   begin;
--   drop function if exists claim_whatsapp_broadcast_recipients(uuid, integer, uuid);
--   drop trigger if exists whatsapp_broadcast_status_events_append_only on whatsapp_broadcast_status_events;
--   drop trigger if exists whatsapp_broadcast_status_events_no_truncate on whatsapp_broadcast_status_events;
--   drop function if exists whatsapp_broadcast_status_events_append_only();
--   drop table if exists whatsapp_broadcast_status_events;
--   drop table if exists whatsapp_broadcast_recipients;
--   drop table if exists whatsapp_broadcasts;
--   drop table if exists whatsapp_connection_send_state;
--   drop table if exists whatsapp_send_controls;
--   commit;
-- (Dropping the events table needs the guard trigger gone first, as above; the table drop itself is not a row delete.)

begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- Send controls: the DB-backed kill switch and caps. One global row, optional per-account override rows.
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists whatsapp_send_controls (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  -- null for the global row; the account an override applies to otherwise
  account_id uuid references accounts(id) on delete cascade,
  -- true = sending is stopped. A new row starts STOPPED: say kill_switch = false on purpose to allow sending.
  kill_switch boolean not null default true,
  -- null on an account row means "use the global number"
  max_recipients_per_broadcast integer,
  max_broadcasts_per_day integer,
  max_messages_per_day integer,
  note text,
  updated_at timestamptz not null default now(),
  constraint whatsapp_send_controls_scope_check check (scope in ('global', 'account')),
  constraint whatsapp_send_controls_shape check (
    (scope = 'global' and account_id is null and max_recipients_per_broadcast is not null and max_broadcasts_per_day is not null and max_messages_per_day is not null)
    or (scope = 'account' and account_id is not null)
  ),
  constraint whatsapp_send_controls_caps_positive check (
    (max_recipients_per_broadcast is null or max_recipients_per_broadcast between 1 and 100000)
    and (max_broadcasts_per_day is null or max_broadcasts_per_day between 1 and 1000)
    and (max_messages_per_day is null or max_messages_per_day between 1 and 1000000)
  ),
  constraint whatsapp_send_controls_note_length check (note is null or char_length(note) <= 500)
);

create unique index if not exists whatsapp_send_controls_one_global on whatsapp_send_controls (scope) where scope = 'global';
create unique index if not exists whatsapp_send_controls_one_per_account on whatsapp_send_controls (account_id) where scope = 'account';

-- PLACEHOLDER numbers (see the header). Seeded STOPPED.
insert into whatsapp_send_controls (scope, account_id, kill_switch, max_recipients_per_broadcast, max_broadcasts_per_day, max_messages_per_day)
values ('global', null, true, 500, 2, 250)
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------------------------
-- Per-connection pause: set when Meta reports a restriction, a quality problem or a credential problem. No retry into it.
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists whatsapp_connection_send_state (
  social_account_id uuid primary key references social_accounts(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  paused_at timestamptz,
  pause_reason text,
  -- Meta's numeric error code that caused it, when there was one (a number, never a message)
  meta_error_code integer,
  resumed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint whatsapp_connection_send_state_reason_check check (pause_reason is null or pause_reason in ('quality', 'restricted', 'credentials', 'template', 'policy')),
  constraint whatsapp_connection_send_state_paused_has_reason check (paused_at is null or pause_reason is not null)
);

-- ---------------------------------------------------------------------------------------------------------------------
-- Broadcasts
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists whatsapp_broadcasts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  -- the template row it was built from; the name, language and category are copied so a later template change cannot alter a send
  template_id uuid references whatsapp_message_templates(id) on delete set null,
  template_name text not null,
  template_language text not null,
  template_category text not null,
  -- the body variable values, in order ({{1}}, {{2}} ...), the same for every recipient
  template_params jsonb not null default '[]'::jsonb,
  name text not null,
  status text not null default 'scheduled',
  -- why a paused broadcast is paused (a code, never a message)
  pause_reason text,
  scheduled_for timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  -- set once every eligible contact has a recipient row (hand-off is resumable until then)
  recipients_materialised_at timestamptz,
  audience_estimate integer not null default 0,
  count_total integer not null default 0,
  count_queued integer not null default 0,
  -- handed to Meta and accepted (a message id came back): the M in "N delivered of M"
  count_accepted integer not null default 0,
  count_sent integer not null default 0,
  count_delivered integer not null default 0,
  count_read integer not null default 0,
  count_failed integer not null default 0,
  count_skipped integer not null default 0,
  -- the LazyRelay user who scheduled it (plain id: no foreign key, so removing a user never edits who scheduled a send)
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_broadcasts_status_check check (status in ('scheduled', 'sending', 'completed', 'cancelled', 'paused', 'failed')),
  constraint whatsapp_broadcasts_template_category_check check (template_category in ('marketing', 'utility', 'authentication')),
  constraint whatsapp_broadcasts_pause_reason_check check (pause_reason is null or pause_reason in ('kill_switch', 'connection_unavailable', 'connection_paused', 'template_unusable', 'plan', 'cap_reached', 'send_disabled')),
  constraint whatsapp_broadcasts_name_length check (char_length(name) between 1 and 120),
  constraint whatsapp_broadcasts_template_name_format check (template_name ~ '^[a-z0-9_]{1,512}$'),
  constraint whatsapp_broadcasts_template_language_format check (template_language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  constraint whatsapp_broadcasts_params_array check (jsonb_typeof(template_params) = 'array' and jsonb_array_length(template_params) <= 20),
  constraint whatsapp_broadcasts_counts_nonneg check (
    audience_estimate >= 0 and count_total >= 0 and count_queued >= 0 and count_accepted >= 0 and count_sent >= 0
    and count_delivered >= 0 and count_read >= 0 and count_failed >= 0 and count_skipped >= 0
  )
);

create index if not exists whatsapp_broadcasts_account_idx on whatsapp_broadcasts (account_id, created_at desc);
create index if not exists whatsapp_broadcasts_due_idx on whatsapp_broadcasts (status, scheduled_for);

-- ---------------------------------------------------------------------------------------------------------------------
-- Recipients: one row per contact per broadcast. No phone number, ever.
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists whatsapp_broadcast_recipients (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  broadcast_id uuid not null references whatsapp_broadcasts(id) on delete cascade,
  contact_id uuid not null references whatsapp_contacts(id) on delete cascade,
  status text not null default 'queued',
  skip_reason text,
  -- keyed hash (64 hex) of Meta's message id; null until Meta accepts the message
  message_key text,
  claim_token uuid,
  claimed_at timestamptz,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  -- Meta's numeric error code and a short code of ours, never Meta's message text
  error_code integer,
  failure_reason text,
  handed_off_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_broadcast_recipients_status_check check (status in ('queued', 'claimed', 'handed_off', 'sent', 'delivered', 'read', 'failed', 'skipped')),
  constraint whatsapp_broadcast_recipients_message_key_hashed check (message_key is null or message_key ~ '^[0-9a-f]{64}$'),
  constraint whatsapp_broadcast_recipients_attempts check (attempt_count between 0 and 10),
  constraint whatsapp_broadcast_recipients_skip_reason_format check (skip_reason is null or skip_reason ~ '^[a-z0-9_]{1,60}$'),
  constraint whatsapp_broadcast_recipients_failure_reason_format check (failure_reason is null or failure_reason ~ '^[a-z0-9_]{1,60}$'),
  unique (broadcast_id, contact_id)
);

create index if not exists whatsapp_broadcast_recipients_claim_idx on whatsapp_broadcast_recipients (broadcast_id, status, next_attempt_at);
create unique index if not exists whatsapp_broadcast_recipients_message_key_idx on whatsapp_broadcast_recipients (account_id, message_key) where message_key is not null;
create index if not exists whatsapp_broadcast_recipients_contact_idx on whatsapp_broadcast_recipients (contact_id);

-- ---------------------------------------------------------------------------------------------------------------------
-- Delivery status events (Meta's receipts). Append-only, idempotent by event_key.
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists whatsapp_broadcast_status_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  broadcast_recipient_id uuid not null references whatsapp_broadcast_recipients(id) on delete cascade,
  -- keyed hash (64 hex) of the message id + status + Meta's timestamp: a re-delivery of the same receipt has the same key
  event_key text not null,
  status text not null,
  event_at timestamptz not null,
  error_code integer,
  -- what Meta says it billed the message as (a category, not money) and whether it was billable
  pricing_category text,
  billable boolean,
  created_at timestamptz not null default now(),
  constraint whatsapp_broadcast_status_events_event_key_hashed check (event_key ~ '^[0-9a-f]{64}$'),
  constraint whatsapp_broadcast_status_events_status_check check (status in ('sent', 'delivered', 'read', 'failed')),
  constraint whatsapp_broadcast_status_events_pricing_category_format check (pricing_category is null or pricing_category ~ '^[a-z_]{1,40}$'),
  unique (event_key)
);

create index if not exists whatsapp_broadcast_status_events_recipient_idx on whatsapp_broadcast_status_events (broadcast_recipient_id, event_at);

-- ---------------------------------------------------------------------------------------------------------------------
-- Access: read-only for members of the owning account; only the backend's service role writes.
-- ---------------------------------------------------------------------------------------------------------------------
alter table whatsapp_send_controls enable row level security;
alter table whatsapp_connection_send_state enable row level security;
alter table whatsapp_broadcasts enable row level security;
alter table whatsapp_broadcast_recipients enable row level security;
alter table whatsapp_broadcast_status_events enable row level security;

drop policy if exists whatsapp_send_controls_select_members on whatsapp_send_controls;
create policy whatsapp_send_controls_select_members on whatsapp_send_controls for select to authenticated using (is_account_member(account_id));
drop policy if exists whatsapp_connection_send_state_select_members on whatsapp_connection_send_state;
create policy whatsapp_connection_send_state_select_members on whatsapp_connection_send_state for select to authenticated using (is_account_member(account_id));
drop policy if exists whatsapp_broadcasts_select_members on whatsapp_broadcasts;
create policy whatsapp_broadcasts_select_members on whatsapp_broadcasts for select to authenticated using (is_account_member(account_id));
drop policy if exists whatsapp_broadcast_recipients_select_members on whatsapp_broadcast_recipients;
create policy whatsapp_broadcast_recipients_select_members on whatsapp_broadcast_recipients for select to authenticated using (is_account_member(account_id));
drop policy if exists whatsapp_broadcast_status_events_select_members on whatsapp_broadcast_status_events;
create policy whatsapp_broadcast_status_events_select_members on whatsapp_broadcast_status_events for select to authenticated using (is_account_member(account_id));

-- Until 2026-10-30 Supabase still grants new tables to the browser-facing roles by default; this removes everything but SELECT.
revoke all on whatsapp_send_controls from public, anon, authenticated;
revoke all on whatsapp_connection_send_state from public, anon, authenticated;
revoke all on whatsapp_broadcasts from public, anon, authenticated;
revoke all on whatsapp_broadcast_recipients from public, anon, authenticated;
revoke all on whatsapp_broadcast_status_events from public, anon, authenticated;

grant select on whatsapp_send_controls to authenticated;
grant select on whatsapp_connection_send_state to authenticated;
grant select on whatsapp_broadcasts to authenticated;
grant select on whatsapp_broadcast_recipients to authenticated;
grant select on whatsapp_broadcast_status_events to authenticated;

-- Explicit grants for the backend (Supabase stops granting new tables to the API roles automatically on 2026-10-30).
-- The status events are insert-only even for the backend: no UPDATE, DELETE or TRUNCATE.
grant all on whatsapp_send_controls to service_role;
grant all on whatsapp_connection_send_state to service_role;
grant all on whatsapp_broadcasts to service_role;
grant all on whatsapp_broadcast_recipients to service_role;
grant select, insert on whatsapp_broadcast_status_events to service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- Delivery status events are append-only.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function whatsapp_broadcast_status_events_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'UPDATE' then
    raise exception 'whatsapp_broadcast_status_events is append-only' using errcode = 'LRWB1';
  end if;
  -- DELETE: allowed only when the parent recipient is already gone (the cascade from erasing a contact, a broadcast or an account).
  if exists (select 1 from whatsapp_broadcast_recipients r where r.id = old.broadcast_recipient_id) then
    raise exception 'whatsapp_broadcast_status_events is append-only' using errcode = 'LRWB1';
  end if;
  return old;
end;
$$;

revoke execute on function whatsapp_broadcast_status_events_append_only() from public, anon, authenticated;

drop trigger if exists whatsapp_broadcast_status_events_append_only on whatsapp_broadcast_status_events;
create trigger whatsapp_broadcast_status_events_append_only
  before update or delete on whatsapp_broadcast_status_events
  for each row execute function whatsapp_broadcast_status_events_append_only();

drop trigger if exists whatsapp_broadcast_status_events_no_truncate on whatsapp_broadcast_status_events;
create trigger whatsapp_broadcast_status_events_no_truncate
  before truncate on whatsapp_broadcast_status_events
  for each statement execute function whatsapp_broadcast_status_events_append_only();

-- ---------------------------------------------------------------------------------------------------------------------
-- The atomic claim. Takes up to p_limit queued recipients of a SENDING broadcast, and for each one decides, against the live
-- contact and opt-out rows and inside this one function, whether it may be sent. An opted-out or missing contact, a US (+1)
-- number for a marketing template, or a contact with no stored number is marked skipped and never returned. The rest are marked
-- claimed (with the caller's token, one more attempt counted) and returned with what the sender needs to message them.
-- Skip-locked, so two sender loops never take the same recipient.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function claim_whatsapp_broadcast_recipients(p_broadcast_id uuid, p_limit integer, p_claim_token uuid)
returns table (recipient_id uuid, contact_id uuid, contact_key text, phone_ciphertext text, country_calling_code text, attempt_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  rec record;
  c record;
  v_category text;
  v_attempts integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'claim limit must be 1 to 200' using errcode = 'LRWB2';
  end if;

  -- Only a broadcast that is sending can hand out recipients. FOR SHARE makes a concurrent cancel wait, then re-check.
  select b.template_category into v_category
    from whatsapp_broadcasts b
   where b.id = p_broadcast_id and b.status = 'sending'
     for share of b;
  if not found then
    return;
  end if;

  for rec in
    select r.id, r.contact_id
      from whatsapp_broadcast_recipients r
     where r.broadcast_id = p_broadcast_id
       and r.status = 'queued'
       and (r.next_attempt_at is null or r.next_attempt_at <= now())
     order by r.created_at, r.id
     limit p_limit
       for update of r skip locked
  loop
    select ct.id, ct.account_id, ct.contact_key, ct.wa_contact_key, ct.phone_ciphertext, ct.country_calling_code, ct.consent_status
      into c
      from whatsapp_contacts ct
     where ct.id = rec.contact_id
       for share;

    if not found
       or c.consent_status <> 'opted_in'
       or exists (
            select 1
              from whatsapp_opt_outs o
             where o.account_id = c.account_id
               and (o.contact_key = c.contact_key
                    or o.wa_contact_key = c.contact_key
                    or (c.wa_contact_key is not null and (o.contact_key = c.wa_contact_key or o.wa_contact_key = c.wa_contact_key)))
          ) then
      update whatsapp_broadcast_recipients r set status = 'skipped', skip_reason = 'opted_out_at_claim', updated_at = now() where r.id = rec.id;
    elsif v_category = 'marketing' and c.country_calling_code = '1' then
      update whatsapp_broadcast_recipients r set status = 'skipped', skip_reason = 'us_marketing_blocked', updated_at = now() where r.id = rec.id;
    elsif c.phone_ciphertext is null then
      update whatsapp_broadcast_recipients r set status = 'skipped', skip_reason = 'no_number_stored', updated_at = now() where r.id = rec.id;
    else
      update whatsapp_broadcast_recipients r
         set status = 'claimed', claim_token = p_claim_token, claimed_at = now(), next_attempt_at = null,
             attempt_count = r.attempt_count + 1, updated_at = now()
       where r.id = rec.id
      returning r.attempt_count into v_attempts;
      recipient_id := rec.id;
      contact_id := c.id;
      contact_key := c.contact_key;
      phone_ciphertext := c.phone_ciphertext;
      country_calling_code := c.country_calling_code;
      attempt_count := v_attempts;
      return next;
    end if;
  end loop;
end;
$$;

revoke execute on function claim_whatsapp_broadcast_recipients(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function claim_whatsapp_broadcast_recipients(uuid, integer, uuid) to service_role;

commit;
