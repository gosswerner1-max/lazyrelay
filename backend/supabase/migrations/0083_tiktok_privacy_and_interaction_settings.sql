-- TikTok's Content Sharing Guidelines (developers.tiktok.com/doc/content-sharing-guidelines)
-- require the posting app's own UI to show a privacy-status picker with NO
-- default selection, plus comment/duet/stitch toggles that are OFF by
-- default -- our compose form never had either, and the backend has always
-- hardcoded privacy_level: "SELF_ONLY" with every interaction allowed.
-- Found 2026-09-05 while applying for the Content Posting API's "audited"
-- status (unaudited clients can only post to private accounts, confirmed
-- via the real API error code unaudited_client_can_only_post_to_private_accounts).
-- Same generic-column pattern as board_id/cover_image_url/destination_link:
-- only consumed by the TikTok adapter, every other platform ignores these.
alter table scheduled_posts add column tiktok_privacy_level text;
alter table scheduled_posts add column tiktok_disable_comment boolean not null default true;
alter table scheduled_posts add column tiktok_disable_duet boolean not null default true;
alter table scheduled_posts add column tiktok_disable_stitch boolean not null default true;

alter table recurring_schedules add column tiktok_privacy_level text;
alter table recurring_schedules add column tiktok_disable_comment boolean not null default true;
alter table recurring_schedules add column tiktok_disable_duet boolean not null default true;
alter table recurring_schedules add column tiktok_disable_stitch boolean not null default true;
