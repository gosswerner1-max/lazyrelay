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
import { GoogleBusinessAdapter } from "./googleBusiness.js";
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
  if (process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET && process.env.X_REDIRECT_URI) {
    registry.set("x", new XAdapter(process.env.X_CLIENT_ID, process.env.X_CLIENT_SECRET, process.env.X_REDIRECT_URI));
  }
  if (process.env.GOOGLE_BUSINESS_CLIENT_ID && process.env.GOOGLE_BUSINESS_CLIENT_SECRET && process.env.GOOGLE_BUSINESS_REDIRECT_URI) {
    registry.set(
      "google-business",
      new GoogleBusinessAdapter(process.env.GOOGLE_BUSINESS_CLIENT_ID, process.env.GOOGLE_BUSINESS_CLIENT_SECRET, process.env.GOOGLE_BUSINESS_REDIRECT_URI),
    );
  }
  if (registry.size === 0) {
    registry.set("tiktok", new StubAdapter());
  }
  return registry;
}
