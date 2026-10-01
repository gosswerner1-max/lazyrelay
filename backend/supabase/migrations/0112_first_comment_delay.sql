-- Delay before the first comment: a post can hold its first comment back a
-- chosen number of minutes after the main post is confirmed live.
-- 0 or null means "right away" (the behaviour before this migration).
--
-- first_comment_delay_minutes lives on the post (and on recurring schedules,
-- which copy it onto each generated post). The due time lives on post_results,
-- the per-account result of a post, next to first_comment_posted and
-- first_comment_error, because a post sent to several accounts has one result
-- (and one comment) per account.
--
-- first_comment_due_at   set by the scheduler when the main post is verified live
--                        (now + delay). Null for comments posted immediately.
-- first_comment_claimed_at  set atomically by the worker that takes the comment,
--                        so two workers (or a restart) can never post it twice.

alter table scheduled_posts
  add column if not exists first_comment_delay_minutes integer
    check (first_comment_delay_minutes is null or (first_comment_delay_minutes >= 0 and first_comment_delay_minutes <= 1440));

alter table recurring_schedules
  add column if not exists first_comment_delay_minutes integer
    check (first_comment_delay_minutes is null or (first_comment_delay_minutes >= 0 and first_comment_delay_minutes <= 1440));

alter table post_results
  add column if not exists first_comment_due_at timestamptz,
  add column if not exists first_comment_claimed_at timestamptz;

-- The worker pass looks only at comments still waiting.
create index if not exists post_results_first_comment_due_idx
  on post_results (first_comment_due_at)
  where first_comment_due_at is not null and first_comment_claimed_at is null;
