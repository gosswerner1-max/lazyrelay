-- Carousels: extra images for one post (Instagram, 1 to 9 on top of media_url,
-- so 2 to 10 in all). Validated in backend/src/carousel.ts.

alter table scheduled_posts add column if not exists media_urls text[] not null default '{}';
