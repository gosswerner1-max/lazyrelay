-- Adds WordPress, dev.to, Hashnode and Lemmy as valid platform values (master list #27), same pattern as
-- 0021_discord_tumblr_platform.sql and 0023_x_platform.sql.

alter table oauth_states drop constraint oauth_states_platform_check;
alter table oauth_states add constraint oauth_states_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube', 'mastodon', 'bluesky', 'telegram', 'linkedin', 'threads', 'facebook', 'instagram', 'discord', 'tumblr', 'x', 'wordpress', 'devto', 'hashnode', 'lemmy'));

alter table social_accounts drop constraint social_accounts_platform_check;
alter table social_accounts add constraint social_accounts_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube', 'mastodon', 'bluesky', 'telegram', 'linkedin', 'threads', 'facebook', 'instagram', 'discord', 'tumblr', 'x', 'wordpress', 'devto', 'hashnode', 'lemmy'));
