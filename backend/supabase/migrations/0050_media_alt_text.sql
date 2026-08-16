-- Alt text on images (2026-08-16) — accessibility metadata a customer can
-- attach to an uploaded file, same as every competitor offers. Stored on
-- media_uploads (the file itself) AND denormalized onto scheduled_posts at
-- schedule time (same pattern already used for `content` — copied in at
-- creation, not re-looked-up at send time, so editing/deleting the media
-- library entry later can't silently change what a scheduled post sends).
alter table media_uploads add column alt_text text;
alter table scheduled_posts add column media_alt_text text;
