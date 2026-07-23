-- Adds retry tracking so a transient posting failure (a one-off network
-- blip, a momentary platform-API error) doesn't permanently fail a post
-- that would have gone through on a later attempt. The scheduler now
-- retries with exponential backoff up to a fixed limit before giving up
-- for real — see scheduler.ts's handleFailure().
alter table scheduled_posts add column retry_count integer not null default 0;
