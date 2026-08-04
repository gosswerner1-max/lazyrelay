-- Lets customers with multiple Pinterest boards choose which board a post
-- goes to, instead of always landing on whichever board the API happens to
-- return first (or an auto-created default board). Same pattern as
-- cover_image_url: a generic column, only consumed by the Pinterest adapter.
alter table scheduled_posts add column board_id text;
alter table recurring_schedules add column board_id text;
