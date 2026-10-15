// Extracted from index.ts (2026-08-07) so the metrics poller script can
// build the exact same env-var-gated adapter set without a second,
// drift-prone copy of this construction logic living in two files.
import { StubAdapter } from "./stub.js";
import { TikTokAdapter } from "./tiktok.js";
import { PinterestAdapter } from "./pinterest.js";
import { YouTubeAdapter } from "./youtube.js";
import { MastodonAdapter } from "./mastodon.js";
import { BlueskyAdapter } from "./bluesky.js";
import { TelegramAdapter } from "./telegram.js";
import { LinkedInAdapter } from "./linkedin.js";
import { ThreadsAdapter } from "./threads.js";
import { FacebookAdapter } from "./facebook.js";
import { InstagramAdapter } from "./instagram.js";
import { DiscordAdapter } from "./discord.js";
import { TumblrAdapter } from "./tumblr.js";
import { XAdapter } from "./x.js";
import { WordPressAdapter } from "./wordpress.js";
import { DevToAdapter } from "./devto.js";
import { HashnodeAdapter } from "./hashnode.js";
import { LemmyAdapter } from "./lemmy.js";
import { SlackAdapter } from "./slack.js";
import { NostrAdapter } from "./nostr.js";
import { WhopAdapter } from "./whop.js";
import { WhatsAppAdapter } from "./whatsapp/adapter.js";
import { APP_ID as WHOP_APP_ID_PATTERN } from "./whopApi.js";
import type { PlatformAdapter } from "./types.js";

// Every configured platform gets its own live PlatformAdapter in the
// registry (Map<platform, adapter>). A platform whose env vars aren't set
// simply isn't in the map — callers report it as unconfigured rather than
// silently falling back to a stub.
export function buildPlatformRegistry(): Map<string, PlatformAdapter> {
  const registry = new Map<string, PlatformAdapter>();
  if (process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET && process.env.TIKTOK_REDIRECT_URI) {
    registry.set(
      "tiktok",
      new TikTokAdapter(process.env.TIKTOK_CLIENT_KEY, process.env.TIKTOK_CLIENT_SECRET, process.env.TIKTOK_REDIRECT_URI),
    );
  }
  if (process.env.PINTEREST_APP_ID && process.env.PINTEREST_APP_SECRET && process.env.PINTEREST_REDIRECT_URI) {
    registry.set(
      "pinterest",
      new PinterestAdapter(process.env.PINTEREST_APP_ID, process.env.PINTEREST_APP_SECRET, process.env.PINTEREST_REDIRECT_URI),
    );
  }
  if (process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REDIRECT_URI) {
    registry.set(
      "youtube",
      new YouTubeAdapter(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET, process.env.YOUTUBE_REDIRECT_URI),
    );
  }
  if (process.env.MASTODON_REDIRECT_URI) {
    registry.set("mastodon", new MastodonAdapter(process.env.MASTODON_REDIRECT_URI));
  }
  if (process.env.BLUESKY_CONNECT_PAGE_URL) {
    registry.set("bluesky", new BlueskyAdapter(process.env.BLUESKY_CONNECT_PAGE_URL));
  }
  // TELEGRAM_BOT_TOKEN/TELEGRAM_LOG_CHAT_ID retired 2026-09-08 -- the
  // shared-bot model they supported is gone, each customer now supplies
  // their own bot token at connect time (see telegram.ts's class comment).
  if (process.env.TELEGRAM_CONNECT_PAGE_URL) {
    registry.set("telegram", new TelegramAdapter(process.env.TELEGRAM_CONNECT_PAGE_URL));
  }
  if (process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET && process.env.LINKEDIN_REDIRECT_URI) {
    registry.set(
      "linkedin",
      new LinkedInAdapter(process.env.LINKEDIN_CLIENT_ID, process.env.LINKEDIN_CLIENT_SECRET, process.env.LINKEDIN_REDIRECT_URI),
    );
  }
  if (process.env.THREADS_APP_ID && process.env.THREADS_APP_SECRET && process.env.THREADS_REDIRECT_URI) {
    registry.set(
      "threads",
      new ThreadsAdapter(process.env.THREADS_APP_ID, process.env.THREADS_APP_SECRET, process.env.THREADS_REDIRECT_URI),
    );
  }
  if (process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_REDIRECT_URI) {
    registry.set("facebook", new FacebookAdapter(process.env.META_APP_ID, process.env.META_APP_SECRET, process.env.META_REDIRECT_URI));
    registry.set("instagram", new InstagramAdapter(process.env.META_APP_ID, process.env.META_APP_SECRET, process.env.META_REDIRECT_URI));
  }
  if (process.env.DISCORD_CONNECT_PAGE_URL) {
    // DISCORD_BOT_TOKEN is optional -- posting via webhook works without
    // it (see discord.ts's class comment); reply/comments just no-op
    // cleanly until it's set.
    registry.set("discord", new DiscordAdapter(process.env.DISCORD_CONNECT_PAGE_URL, process.env.DISCORD_BOT_TOKEN));
  }
  if (process.env.TUMBLR_CLIENT_ID && process.env.TUMBLR_CLIENT_SECRET && process.env.TUMBLR_REDIRECT_URI) {
    registry.set(
      "tumblr",
      new TumblrAdapter(process.env.TUMBLR_CLIENT_ID, process.env.TUMBLR_CLIENT_SECRET, process.env.TUMBLR_REDIRECT_URI),
    );
  }
  // X is bring-your-own-key only (Werner, 2026-10-10): there is no LazyRelay X app and no X_CLIENT_ID/SECRET/REDIRECT_URI.
  // Registered when X_BYOK_ENABLED=true and nothing else; even then hidden from customers until X_BYOK_PLATFORM_PUBLIC (or
  // X_BYOK_TEST_ACCOUNT_IDS) switches it on, see socialAccounts.routes.ts. Credentials arrive per call, inside the login string.
  if (process.env.X_BYOK_ENABLED === "true") {
    registry.set("x", new XAdapter());
  }
  // Article and forum platforms (master list #27): the customer pastes a credential on LazyRelay's own connect
  // page (the same shape as Discord), so each only needs the address of that page.
  if (process.env.WORDPRESS_CONNECT_PAGE_URL) {
    registry.set("wordpress", new WordPressAdapter(process.env.WORDPRESS_CONNECT_PAGE_URL));
  }
  if (process.env.DEVTO_CONNECT_PAGE_URL) {
    registry.set("devto", new DevToAdapter(process.env.DEVTO_CONNECT_PAGE_URL));
  }
  if (process.env.HASHNODE_CONNECT_PAGE_URL) {
    registry.set("hashnode", new HashnodeAdapter(process.env.HASHNODE_CONNECT_PAGE_URL));
  }
  if (process.env.LEMMY_CONNECT_PAGE_URL) {
    registry.set("lemmy", new LemmyAdapter(process.env.LEMMY_CONNECT_PAGE_URL));
  }
  // Slack (OAuth, bot token, one channel per connection). Registered only when all three settings exist, and even
  // then it stays hidden from customers until SLACK_PLATFORM_PUBLIC (or a test-account list) switches it on, see
  // socialAccounts.routes.ts. Until the three settings are set it simply is not in the registry.
  if (process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET && process.env.SLACK_REDIRECT_URI) {
    registry.set("slack", new SlackAdapter(process.env.SLACK_CLIENT_ID, process.env.SLACK_CLIENT_SECRET, process.env.SLACK_REDIRECT_URI));
  }
  // Nostr (NIP-46 remote signing): the customer pastes a bunker:// link on LazyRelay's own connect page. Registered
  // only when that page address is set, and even then hidden from customers until NOSTR_PLATFORM_PUBLIC (or a test
  // account list) switches it on, see socialAccounts.routes.ts.
  if (process.env.NOSTR_CONNECT_PAGE_URL) {
    registry.set("nostr", new NostrAdapter(process.env.NOSTR_CONNECT_PAGE_URL));
  }
  // Whop: ONE app and ONE API key for every community (no per-customer secret), so it needs both settings. Registered
  // only when WHOP_APP_API_KEY and a well formed WHOP_APP_ID exist, and even then hidden from customers until
  // WHOP_PLATFORM_PUBLIC (or a test account list) switches it on, see socialAccounts.routes.ts.
  if (process.env.WHOP_APP_API_KEY && process.env.WHOP_APP_ID) {
    if (WHOP_APP_ID_PATTERN.test(process.env.WHOP_APP_ID)) {
      registry.set("whop", new WhopAdapter(process.env.WHOP_APP_API_KEY, process.env.WHOP_APP_ID));
    } else {
      console.warn("WHOP_APP_ID is set but is not a Whop app id (app_...): Whop stays switched off.");
    }
  }
  // WhatsApp is bring-your-own-key only: there is no LazyRelay WhatsApp app and no WhatsApp token in the environment.
  // The adapter is stateless; each connection's Meta system user token is decrypted from Vault at run time. Registered
  // when WHATSAPP_BYOK_ENABLED=true and nothing else; even then hidden from customers until WHATSAPP_BYOK_PLATFORM_PUBLIC
  // (or WHATSAPP_BYOK_TEST_ACCOUNT_IDS) switches it on, see socialAccounts.routes.ts.
  if (process.env.WHATSAPP_BYOK_ENABLED === "true") {
    registry.set("whatsapp", new WhatsAppAdapter());
  }
  if (registry.size === 0) {
    registry.set("tiktok", new StubAdapter());
  }
  return registry;
}
