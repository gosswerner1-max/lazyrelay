-- Draft-first reply loop: the sender's retry state (DRAFT FOR REVIEW, not applied anywhere).
--
-- The sender (backend/src/replySender.ts) retries a reply only when the failure proves nothing was
-- posted (rate limited, the server could not be reached, the service said it was unavailable). A
-- failure that is ambiguous (a timeout after the request left) is NOT retried: it becomes "failed"
-- with a note to check the account, because retrying could post the same reply twice.
--
-- send_attempts counts the tries so far (the sender gives up after 5). next_attempt_at is when the
-- next try may run: null means "as soon as the sender looks" (a freshly approved draft), a time
-- means "after this moment" (waiting out a rate limit). Same idea as webhook_deliveries (0098).
--
-- Applies on top of 0115_reply_drafts.sql. The table's access rules (RLS on, no policies, no
-- privileges for anon or authenticated, service_role only) already cover new columns.
--
-- One transaction: all of it applies, or none of it does.

begin;

alter table reply_drafts
  add column send_attempts integer not null default 0 check (send_attempts between 0 and 20),
  add column next_attempt_at timestamptz;

-- The sender's question: which approved drafts are due? Oldest decision first.
create index reply_drafts_send_due_idx on reply_drafts (next_attempt_at nulls first, decided_at)
  where status = 'approved';

commit;
