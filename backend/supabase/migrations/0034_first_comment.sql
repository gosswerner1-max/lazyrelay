-- First-comment auto-posting (2026-08-07) — priority #2 from the
-- 2026-08-07 competitor audit. After a post is confirmed live, optionally
-- post a follow-up comment (the common Instagram/Facebook pattern of
-- hiding hashtags in the first comment). v1 scope: Facebook + Instagram
-- only, the platforms this feature is actually validated for — see
-- werner-brain vault: project-competitor-feature-audit-2026-08-07.md.
-- Same generic-column pattern as board_id: consumed only by adapters that
-- implement the new optional postComment() method.
alter table scheduled_posts add column first_comment text;
alter table recurring_schedules add column first_comment text;

-- Comment posting is a lesser-severity, non-fatal step that happens AFTER
-- the parent post is already verified live — a failure here must never
-- flip the parent post's own status to failed or retry it. Recorded
-- alongside post_results (the Proof-of-Publish table) rather than a new
-- table, since it's fundamentally more verification data about the same
-- post, not a separate entity.
alter table post_results add column first_comment_posted boolean;
alter table post_results add column first_comment_error text;
