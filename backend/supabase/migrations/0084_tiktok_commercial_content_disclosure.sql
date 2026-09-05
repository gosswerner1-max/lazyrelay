-- TikTok's Content Sharing Guidelines (developers.tiktok.com/doc/content-sharing-guidelines)
-- also require a Commercial Content Disclosure control on the compose page --
-- off by default, revealing "Your Brand" / "Branded Content" checkboxes when
-- turned on. Found 2026-09-05, same audit-application session as migration
-- 0083 (privacy level + comment/duet/stitch), reading the same guidelines doc
-- in full rather than just the fields already built. Same generic-column
-- pattern as the fields in 0083: only consumed by the TikTok adapter, every
-- other platform ignores these.
alter table scheduled_posts add column tiktok_brand_organic boolean not null default false;
alter table scheduled_posts add column tiktok_brand_content boolean not null default false;

alter table recurring_schedules add column tiktok_brand_organic boolean not null default false;
alter table recurring_schedules add column tiktok_brand_content boolean not null default false;
