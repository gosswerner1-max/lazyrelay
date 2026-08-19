-- Real bug found in a 2026-08-19 security review: Pinterest Pin creation
-- never sent Pinterest's own "Destination Link" field at all (only
-- board_id/title/description/media_source) — every Pin posted through
-- LazyRelay had a silently blank destination link. Same generic-column
-- pattern as board_id/cover_image_url: only consumed by the Pinterest
-- adapter, every other platform ignores it.
alter table scheduled_posts add column destination_link text;
alter table recurring_schedules add column destination_link text;
