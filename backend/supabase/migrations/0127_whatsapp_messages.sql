-- 0127: whatsapp_messages, one row per inbound WhatsApp message (decided by Werner 2026-10-10).
--
-- DRAFT for review on branch feature/whatsapp-byok. NOT applied anywhere. Applied by hand with Werner's yes, after 0124.
--
-- Why a table of its own. Inbound WhatsApp is a message thread, and the customer wants to read the history. The older
-- cache tables hold one row per conversation (dm_conversations_cache) or per comment, so a second message overwrote the
-- first. One row per message also fixes the lost-message case of two messages arriving in the same second.
--
-- Privacy (decided 2026-10-10):
--   * The sender's phone number is NEVER stored. contact_key is a keyed hash of it (HMAC-SHA256 with the server secret
--     WHATSAPP_CONTACT_HASH_KEY, salted with the account id so the same person is not linkable across customers);
--     contact_display is a mask such as '+27 ** *** 1111'. The checks below make the database itself refuse a raw number
--     or an unhashed key even if the backend had a bug.
--   * wamid holds a KEYED HASH of Meta's message id, not the id itself: Meta builds those ids from the sender's number
--     (base64 inside "wamid."), so keeping one raw would keep the number. It exists to de-duplicate (a message Meta
--     delivers twice is stored once).
--   * contact_name (the WhatsApp profile name) and text are personal data and fall under the same 30 day retention:
--     purge_stored_messages() now also deletes whatsapp_messages older than the cutoff, by received_at. Its old columns
--     are unchanged, new ones (messages_deleted, triage_deleted) are added at the end, so backend/src/privacySweep.ts
--     keeps parsing.
--   * The same function now also deletes comment_triage rows older than the cutoff. Those rows hold a model-written
--     reason about a stranger's comment or DM, and nothing purged them, although the privacy promise is that comment and
--     DM text is gone after 30 days. The timestamp is classified_at (the only timestamp the table has); the triage code
--     now refreshes it every time it classifies an item again, so it means "last classified". A verdict that is purged
--     while its item is still on screen is simply re-classified on the next view (one more AI call, no data lost).
--
-- Access: RLS on. A signed-in member of the owning account may READ their account's rows. There are no insert, update or
-- delete policies and the browser-facing roles hold no write privilege: only the backend's service-role client writes.
--
-- Idempotent (safe to apply twice) and wrapped in one transaction: all of it applies, or none of it does.
--
-- ROLLBACK (by hand; it deletes every stored WhatsApp message):
--   begin;
--   drop function if exists purge_stored_messages(timestamptz);
--   create function purge_stored_messages(p_cutoff timestamptz)
--   returns table (comments_deleted bigint, dms_deleted bigint)
--   language plpgsql security definer set search_path = public as $fn$
--   declare v_comments bigint; v_dms bigint;
--   begin
--     with gone as (delete from mention_comments_cache m
--       where coalesce(m.comment_created_at, m.first_seen_at) < p_cutoff
--          or exists (select 1 from scheduled_posts p where p.id = m.scheduled_post_id and p.scheduled_for < p_cutoff)
--       returning 1) select count(*) into v_comments from gone;
--     with gone as (delete from dm_conversations_cache d
--       where coalesce(d.conversation_updated_at, d.first_seen_at) < p_cutoff returning 1) select count(*) into v_dms from gone;
--     return query select v_comments, v_dms;
--   end; $fn$;
--   revoke execute on function purge_stored_messages(timestamptz) from public, anon, authenticated;
--   grant execute on function purge_stored_messages(timestamptz) to service_role;
--   drop table if exists whatsapp_messages;
--   commit;

begin;

create table if not exists whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  -- keyed hash (64 hex characters) of Meta's message id; see the header
  wamid text not null,
  -- keyed, account-scoped hash (64 hex characters) of the sender's number: groups a thread without storing the number
  contact_key text not null,
  -- masked number for display, e.g. '+27 ** *** 1111'
  contact_display text,
  -- the sender's WhatsApp profile name (personal data, same retention)
  contact_name text,
  text text not null,
  received_at timestamptz not null,
  -- AI triage verdict; all null while triage is off or the message was not classified (never "routine" by default)
  triage_category text,
  needs_attention boolean,
  triage_reason text,
  triaged_at timestamptz,
  created_at timestamptz not null default now(),
  constraint whatsapp_messages_text_length check (char_length(text) <= 4096),
  constraint whatsapp_messages_wamid_hashed check (wamid ~ '^[0-9a-f]{64}$'),
  constraint whatsapp_messages_contact_key_hashed check (contact_key ~ '^[0-9a-f]{64}$'),
  constraint whatsapp_messages_contact_display_masked check (contact_display is null or (char_length(contact_display) <= 24 and contact_display !~ '[0-9]{7}')),
  constraint whatsapp_messages_triage_category_check check (triage_category is null or triage_category in ('angry_customer', 'sales_question', 'question', 'routine')),
  constraint whatsapp_messages_triage_reason_length check (triage_reason is null or char_length(triage_reason) <= 200),
  -- idempotency: a message delivered twice is stored once
  constraint whatsapp_messages_social_wamid_key unique (social_account_id, wamid)
);

-- A thread, newest first.
create index if not exists whatsapp_messages_thread_idx on whatsapp_messages (social_account_id, contact_key, received_at desc);
-- The retention purge.
create index if not exists whatsapp_messages_received_at_idx on whatsapp_messages (received_at);
-- One plain index per foreign key that no index above leads with (deleting an account would otherwise scan the table).
create index if not exists whatsapp_messages_account_idx on whatsapp_messages (account_id);

alter table whatsapp_messages enable row level security;

drop policy if exists whatsapp_messages_select_members on whatsapp_messages;
create policy whatsapp_messages_select_members on whatsapp_messages for select to authenticated using (is_account_member(account_id));

-- Browser-facing roles: read only, through the policy above. (Until 2026-10-30 Supabase still grants new tables to these
-- roles by default; this removes everything but SELECT.)
revoke all on whatsapp_messages from public, anon, authenticated;
grant select on whatsapp_messages to authenticated;
-- Explicit grant for the backend, because Supabase stops granting new tables to the API roles automatically on
-- 2026-10-30 (same as 0110, 0114 and 0115).
grant all on whatsapp_messages to service_role;

-- purge_stored_messages gains a third column, so it is dropped and recreated (a function's result columns cannot be
-- changed in place). Same name, same argument, same SECURITY DEFINER and search_path, same grants as in 0117.
drop function if exists purge_stored_messages(timestamptz);
create function purge_stored_messages(p_cutoff timestamptz)
returns table (comments_deleted bigint, dms_deleted bigint, messages_deleted bigint, triage_deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_comments bigint;
  v_dms bigint;
  v_messages bigint;
  v_triage bigint;
begin
  with gone as (
    delete from mention_comments_cache m
    where coalesce(m.comment_created_at, m.first_seen_at) < p_cutoff
       or exists (select 1 from scheduled_posts p where p.id = m.scheduled_post_id and p.scheduled_for < p_cutoff)
    returning 1
  )
  select count(*) into v_comments from gone;

  with gone as (
    delete from dm_conversations_cache d
    where coalesce(d.conversation_updated_at, d.first_seen_at) < p_cutoff
    returning 1
  )
  select count(*) into v_dms from gone;

  -- Inbound WhatsApp messages: by the time the message was received.
  with gone as (
    delete from whatsapp_messages w
    where w.received_at < p_cutoff
    returning 1
  )
  select count(*) into v_messages from gone;

  -- Cached triage verdicts (comments and DMs): by when they were last classified.
  with gone as (
    delete from comment_triage t
    where t.classified_at < p_cutoff
    returning 1
  )
  select count(*) into v_triage from gone;

  return query select v_comments, v_dms, v_messages, v_triage;
end;
$$;

revoke execute on function purge_stored_messages(timestamptz) from public, anon, authenticated;
grant execute on function purge_stored_messages(timestamptz) to service_role;

commit;
