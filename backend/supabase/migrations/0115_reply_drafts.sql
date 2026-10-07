-- Draft-first reply loop: the drafts table (design 2026-10-07, DRAFT FOR REVIEW, not applied anywhere).
--
-- When a comment arrives, LazyRelay may write a suggested reply and hold it here until a
-- person approves, edits or discards it. Nothing in this table is ever sent without that
-- decision. One row per comment; the backend's service-role key is the only reader and
-- writer (RLS on, no policies, same fail-closed pattern as mention_comments_cache, 0058,
-- and saved_snippets, 0099).
--
-- Not built here: the poller that writes drafts, the review screen, the approve and
-- discard routes. Those come after this table and ship behind a kill switch that is off.
--
-- Differences from the 2026-10-07 blueprint, on purpose:
--   * Unique on (scheduled_post_id, platform_comment_id), the same pair
--     mention_comments_cache is unique on, instead of (account_id, platform_comment_id):
--     comment ids are only guaranteed unique inside one platform's post.
--   * An extra status needs_input: the model could not answer from the facts the customer
--     supplied, so there is no draft text, only a prompt for the owner.
--   * The database itself refuses a draft for an angry_customer comment (rule 5 of the
--     blueprint: money, legal, security and angry customers are escalated, never drafted).
--     Only the three categories that may get a draft are allowed.
--
-- status flow:
--   pending_review / needs_input -> approved -> sending -> sent | failed
--   pending_review / needs_input -> discarded | expired
--   failed -> approved (retry)
-- Moving between statuses is done by one conditional UPDATE (WHERE status = <expected>),
-- so two clicks or two workers cannot send the same reply twice.
--
-- Wrapped in one transaction: all of it applies, or none of it does.

begin;

create table reply_drafts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  scheduled_post_id uuid not null references scheduled_posts(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,

  -- The comment this draft answers: the platform's own comment id, the same value as
  -- mention_comments_cache.platform_comment_id. No foreign key to the cache on purpose:
  -- the cache is refreshed by a poller and a draft must outlive a refresh.
  platform_comment_id text not null,
  -- comment_triage.source_signature for this comment (the comment id again, because comment
  -- text never changes after posting). Kept so a future re-triage can tell stale from fresh.
  source_signature text not null,
  -- Same four-way split as comment_triage.category, minus angry_customer (see header).
  triage_category text not null check (triage_category in ('sales_question', 'question', 'routine')),

  status text not null default 'pending_review'
    check (status in ('pending_review', 'needs_input', 'approved', 'sending', 'sent', 'failed', 'discarded', 'expired')),

  -- What the model wrote. Null only for needs_input. 2000 characters is the reply box's own limit.
  draft_text text check (draft_text is null or char_length(draft_text) between 1 and 2000),
  -- What the owner changed it to, if they edited it. The text that is sent is
  -- coalesce(edited_text, draft_text).
  edited_text text check (edited_text is null or char_length(edited_text) between 1 and 2000),
  model text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A draft nobody reviews goes stale: a sweep marks it expired after this moment.
  expires_at timestamptz not null default (now() + interval '7 days'),
  -- Who decided (approved or discarded) and when. decided_by is the person, not the account.
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  sent_at timestamptz,
  -- The id the platform gave the posted reply, when it gives one.
  platform_reply_id text,
  -- The platform's reason when a send fails (kept short and scrubbed by the backend, like post_results).
  error text,

  unique (scheduled_post_id, platform_comment_id),

  -- A needs_input row has no draft text; a row waiting for review always has one. Rows that moved on
  -- (discarded, expired) may be either, because a needs_input row can be discarded or can expire.
  constraint reply_drafts_needs_input_has_no_draft check (status <> 'needs_input' or draft_text is null),
  constraint reply_drafts_pending_has_draft check (status <> 'pending_review' or draft_text is not null),
  -- Anything approved or beyond must have a text to send.
  constraint reply_drafts_sendable_has_text check (
    status not in ('approved', 'sending', 'sent') or coalesce(edited_text, draft_text) is not null
  ),
  constraint reply_drafts_sent_has_time check (status <> 'sent' or sent_at is not null)
);

comment on table reply_drafts is
  'Suggested replies to comments, held until a person approves them. Service-role only. Never sent without a decision.';

-- The review list: this account's drafts that still need a decision, newest first.
create index reply_drafts_review_idx on reply_drafts (account_id, created_at desc)
  where status in ('pending_review', 'needs_input');
-- The expiry sweep.
create index reply_drafts_expiry_idx on reply_drafts (expires_at)
  where status in ('pending_review', 'needs_input');
-- The stuck-send sweep: a row left in "sending" by a crashed worker.
create index reply_drafts_sending_idx on reply_drafts (updated_at) where status = 'sending';
-- One plain index per foreign key (the partial indexes above do not cover every row, so deleting an
-- account or a social account would scan the table), same reason as 0089. scheduled_post_id is covered
-- by the unique constraint, whose leading column it is.
create index reply_drafts_account_idx on reply_drafts (account_id);
create index reply_drafts_social_account_idx on reply_drafts (social_account_id);
create index reply_drafts_decided_by_idx on reply_drafts (decided_by) where decided_by is not null;

-- updated_at moves on every change, same pattern as scheduled_posts (0070).
create function touch_reply_drafts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger reply_drafts_touch_updated_at
  before update on reply_drafts
  for each row execute function touch_reply_drafts_updated_at();

alter table reply_drafts enable row level security;
-- No policies for anon or authenticated: only the backend's service-role client touches this table.
-- Belt and braces: the browser-facing roles get no table privileges at all, so even a policy added by
-- mistake later could not expose it. (Until 2026-10-30 Supabase still grants new tables to these roles
-- by default; this removes that grant.)
revoke all on reply_drafts from anon, authenticated;
-- Explicit grant for the backend, because Supabase stops granting new tables to the API roles
-- automatically on 2026-10-30 (same as 0110 and 0114).
grant all on reply_drafts to service_role;

commit;
