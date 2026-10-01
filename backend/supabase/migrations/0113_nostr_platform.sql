-- Adds Nostr as a valid platform value, same pattern as 0111_slack_platform.sql. Nothing else changes: the platform
-- stays hidden from customers until NOSTR_CONNECT_PAGE_URL and a release switch are set (see socialAccounts.routes.ts).
-- Numbered 0113 because 0112 is taken by the first-comment-delay branch.

alter table oauth_states drop constraint oauth_states_platform_check;
alter table oauth_states add constraint oauth_states_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube', 'mastodon', 'bluesky', 'telegram', 'linkedin', 'threads', 'facebook', 'instagram', 'discord', 'tumblr', 'x', 'wordpress', 'devto', 'hashnode', 'lemmy', 'slack', 'nostr'));

alter table social_accounts drop constraint social_accounts_platform_check;
alter table social_accounts add constraint social_accounts_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube', 'mastodon', 'bluesky', 'telegram', 'linkedin', 'threads', 'facebook', 'instagram', 'discord', 'tumblr', 'x', 'wordpress', 'devto', 'hashnode', 'lemmy', 'slack', 'nostr'));
