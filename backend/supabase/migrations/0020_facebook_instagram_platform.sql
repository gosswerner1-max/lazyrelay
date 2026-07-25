-- Adds "facebook" and "instagram" as valid platform values, same pattern as
-- 0019_threads_platform.sql.

alter table oauth_states drop constraint oauth_states_platform_check;
alter table oauth_states add constraint oauth_states_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube', 'mastodon', 'bluesky', 'telegram', 'linkedin', 'threads', 'facebook', 'instagram'));

alter table social_accounts drop constraint social_accounts_platform_check;
alter table social_accounts add constraint social_accounts_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube', 'mastodon', 'bluesky', 'telegram', 'linkedin', 'threads', 'facebook', 'instagram'));
