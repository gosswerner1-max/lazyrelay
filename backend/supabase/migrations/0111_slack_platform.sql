-- Adds Slack as a valid platform value, same pattern as 0108_article_platforms.sql. Nothing else changes: the platform
-- stays hidden from customers until its settings and release switch are set (see socialAccounts.routes.ts).

alter table oauth_states drop constraint oauth_states_platform_check;
alter table oauth_states add constraint oauth_states_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube', 'mastodon', 'bluesky', 'telegram', 'linkedin', 'threads', 'facebook', 'instagram', 'discord', 'tumblr', 'x', 'wordpress', 'devto', 'hashnode', 'lemmy', 'slack'));

alter table social_accounts drop constraint social_accounts_platform_check;
alter table social_accounts add constraint social_accounts_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube', 'mastodon', 'bluesky', 'telegram', 'linkedin', 'threads', 'facebook', 'instagram', 'discord', 'tumblr', 'x', 'wordpress', 'devto', 'hashnode', 'lemmy', 'slack'));
