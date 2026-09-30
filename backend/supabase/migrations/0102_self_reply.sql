-- Self-reply at N likes: a post can carry a follow-up comment LazyRelay adds
-- once the post reaches a like count the customer chose. Checked by the metrics
-- poller (backend/src/metricsPoller.ts) at each engagement checkpoint, so it
-- lands at the next checkpoint after the target is reached, not instantly.
-- self_reply_done_at makes it one-shot.

alter table scheduled_posts
  add column if not exists self_reply_text text,
  add column if not exists self_reply_at_likes integer,
  add column if not exists self_reply_done_at timestamptz,
  add column if not exists self_reply_error text;
