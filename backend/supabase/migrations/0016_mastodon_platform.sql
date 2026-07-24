-- Adds "mastodon" and "bluesky" as valid platform values, same pattern as
-- 0015_youtube_platform.sql — both oauth_states.platform and
-- social_accounts.platform reject any value not in their check constraint.

alter table oauth_states drop constraint oauth_states_platform_check;
alter table oauth_states add constraint oauth_states_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube', 'mastodon', 'bluesky'));

alter table social_accounts drop constraint social_accounts_platform_check;
alter table social_accounts add constraint social_accounts_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube', 'mastodon', 'bluesky'));
