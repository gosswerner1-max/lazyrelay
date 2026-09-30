-- Post tags: up to 5 short labels per post (e.g. "launch", "giveaway") so a
-- customer can filter analytics by campaign. Plain text[]; cleaned and capped
-- in backend/src/postTags.ts. GIN index for the analytics tag filter.

alter table scheduled_posts add column if not exists tags text[] not null default '{}';

create index if not exists scheduled_posts_tags_idx on scheduled_posts using gin (tags);
