-- Optional still-image sidecar for video media. Currently only consumed by
-- the Pinterest adapter (video Pins require a cover_image_url), but stored
-- as a generic column alongside media_url rather than platform-namespaced,
-- matching how media_url itself is shared across every adapter.
alter table scheduled_posts add column cover_image_url text;
alter table recurring_schedules add column cover_image_url text;
