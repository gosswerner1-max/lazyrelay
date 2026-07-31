import "dotenv/config";
import { supabase } from "./supabase.js";
import { runSchedulerCycle } from "./scheduler.js";
import { generateDuePosts } from "./recurringScheduler.js";
import { StubAdapter } from "./platforms/stub.js";
import { TikTokAdapter } from "./platforms/tiktok.js";
import { PinterestAdapter } from "./platforms/pinterest.js";
import { YouTubeAdapter } from "./platforms/youtube.js";
import { MastodonAdapter } from "./platforms/mastodon.js";
import { BlueskyAdapter } from "./platforms/bluesky.js";
import { TelegramAdapter } from "./platforms/telegram.js";
import { LinkedInAdapter } from "./platforms/linkedin.js";
import { ThreadsAdapter } from "./platforms/threads.js";
import { FacebookAdapter } from "./platforms/facebook.js";
import { InstagramAdapter } from "./platforms/instagram.js";
import { DiscordAdapter } from "./platforms/discord.js";
import { TumblrAdapter } from "./platforms/tumblr.js";
import { XAdapter } from "./platforms/x.js";
import type { PlatformAdapter } from "./platforms/types.js";
import { StubMorAdapter } from "./billing/stub.js";
import { PaddleMorAdapter } from "./billing/paddle.js";
import { Environment } from "@paddle/paddle-node-sdk";
import { buildApp } from "./http/app.js";
import type { MerchantOfRecordAdapter } from "./billing/types.js";

const POLL_INTERVAL_MS = 30_000;
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

async function main() {
  const { error } = await supabase.from("accounts").select("id").limit(1);
  if (error) {
    console.error("Supabase connection failed:", error.message);
    process.exit(1);
  }
  console.log("Connected to Supabase.");

  // Every configured platform gets its own live PlatformAdapter in the
  // registry (Map<platform, adapter>) — replaces the old single
  // ACTIVE_PLATFORM slot now that 12 real adapters exist and customers need
  // to connect/post to several at once. A platform whose env vars aren't
  // set simply isn't in the map — /api/platforms reports it as
  // unconfigured rather than silently falling back to a stub.
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
    // No client id/secret env vars — Mastodon app registration is
    // self-service and instant (POST /api/v1/apps), so the adapter
    // registers itself against its default instance on first use rather
    // than requiring pre-provisioned credentials like every other platform.
    registry.set("mastodon", new MastodonAdapter(process.env.MASTODON_REDIRECT_URI));
  }
  if (process.env.BLUESKY_CONNECT_PAGE_URL) {
    // No client id/secret — this adapter uses app passwords, not OAuth
    // (see platforms/bluesky.ts), so the only real config it needs is
    // where LazyRelay's own connect-form page lives.
    registry.set("bluesky", new BlueskyAdapter(process.env.BLUESKY_CONNECT_PAGE_URL));
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CONNECT_PAGE_URL) {
    // No OAuth at all — TELEGRAM_BOT_TOKEN authenticates every call as the
    // one shared @lazyrelay_bot; TELEGRAM_LOG_CHAT_ID is optional but
    // strongly recommended (see platforms/telegram.ts) for real per-message
    // Proof-of-Publish verification instead of a degraded channel-only check.
    registry.set(
      "telegram",
      new TelegramAdapter(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CONNECT_PAGE_URL, process.env.TELEGRAM_LOG_CHAT_ID),
    );
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
    registry.set("discord", new DiscordAdapter(process.env.DISCORD_CONNECT_PAGE_URL));
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
  if (registry.size === 0) {
    // Keeps local/dev environments with no platform env vars set at all
    // working end-to-end against the stub, same as before the registry.
    registry.set("tiktok", new StubAdapter());
  }
  const morAdapter: MerchantOfRecordAdapter =
    process.env.MOR_API_KEY && process.env.MOR_WEBHOOK_SECRET
      ? new PaddleMorAdapter(
          process.env.MOR_API_KEY,
          process.env.MOR_WEBHOOK_SECRET,
          process.env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox
        )
      : new StubMorAdapter();
  console.log(`Billing adapter: ${morAdapter.constructor.name}`);
  console.log(
    `Platform registry: ${Array.from(registry.keys()).join(", ") || "(none — using stub)"}; ` +
      `TIKTOK_CLIENT_KEY=${process.env.TIKTOK_CLIENT_KEY ? "set" : "MISSING"} ` +
      `TIKTOK_CLIENT_SECRET=${process.env.TIKTOK_CLIENT_SECRET ? "set" : "MISSING"} ` +
      `TIKTOK_REDIRECT_URI=${process.env.TIKTOK_REDIRECT_URI ? "set" : "MISSING"}; ` +
      `PINTEREST_APP_ID=${process.env.PINTEREST_APP_ID ? "set" : "MISSING"} ` +
      `PINTEREST_APP_SECRET=${process.env.PINTEREST_APP_SECRET ? "set" : "MISSING"} ` +
      `PINTEREST_REDIRECT_URI=${process.env.PINTEREST_REDIRECT_URI ? "set" : "MISSING"}; ` +
      `YOUTUBE_CLIENT_ID=${process.env.YOUTUBE_CLIENT_ID ? "set" : "MISSING"} ` +
      `YOUTUBE_CLIENT_SECRET=${process.env.YOUTUBE_CLIENT_SECRET ? "set" : "MISSING"} ` +
      `YOUTUBE_REDIRECT_URI=${process.env.YOUTUBE_REDIRECT_URI ? "set" : "MISSING"}; ` +
      `MASTODON_REDIRECT_URI=${process.env.MASTODON_REDIRECT_URI ? "set" : "MISSING"}; ` +
      `BLUESKY_CONNECT_PAGE_URL=${process.env.BLUESKY_CONNECT_PAGE_URL ? "set" : "MISSING"}; ` +
      `TELEGRAM_BOT_TOKEN=${process.env.TELEGRAM_BOT_TOKEN ? "set" : "MISSING"} ` +
      `TELEGRAM_CONNECT_PAGE_URL=${process.env.TELEGRAM_CONNECT_PAGE_URL ? "set" : "MISSING"} ` +
      `TELEGRAM_LOG_CHAT_ID=${process.env.TELEGRAM_LOG_CHAT_ID ? "set" : "MISSING"}; ` +
      `LINKEDIN_CLIENT_ID=${process.env.LINKEDIN_CLIENT_ID ? "set" : "MISSING"} ` +
      `LINKEDIN_CLIENT_SECRET=${process.env.LINKEDIN_CLIENT_SECRET ? "set" : "MISSING"} ` +
      `LINKEDIN_REDIRECT_URI=${process.env.LINKEDIN_REDIRECT_URI ? "set" : "MISSING"}; ` +
      `THREADS_APP_ID=${process.env.THREADS_APP_ID ? "set" : "MISSING"} ` +
      `THREADS_APP_SECRET=${process.env.THREADS_APP_SECRET ? "set" : "MISSING"} ` +
      `THREADS_REDIRECT_URI=${process.env.THREADS_REDIRECT_URI ? "set" : "MISSING"}; ` +
      `META_APP_ID=${process.env.META_APP_ID ? "set" : "MISSING"} ` +
      `META_APP_SECRET=${process.env.META_APP_SECRET ? "set" : "MISSING"} ` +
      `META_REDIRECT_URI=${process.env.META_REDIRECT_URI ? "set" : "MISSING"}; ` +
      `DISCORD_CONNECT_PAGE_URL=${process.env.DISCORD_CONNECT_PAGE_URL ? "set" : "MISSING"}; ` +
      `TUMBLR_CLIENT_ID=${process.env.TUMBLR_CLIENT_ID ? "set" : "MISSING"} ` +
      `TUMBLR_CLIENT_SECRET=${process.env.TUMBLR_CLIENT_SECRET ? "set" : "MISSING"} ` +
      `TUMBLR_REDIRECT_URI=${process.env.TUMBLR_REDIRECT_URI ? "set" : "MISSING"}; ` +
      `X_CLIENT_ID=${process.env.X_CLIENT_ID ? "set" : "MISSING"} ` +
      `X_CLIENT_SECRET=${process.env.X_CLIENT_SECRET ? "set" : "MISSING"} ` +
      `X_REDIRECT_URI=${process.env.X_REDIRECT_URI ? "set" : "MISSING"}; ` +
      `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "set" : "MISSING"}`,
  );

  const app = buildApp(morAdapter, registry);
  app.listen(PORT, () => console.log(`HTTP API listening on :${PORT}`));

  setInterval(() => {
    runSchedulerCycle(registry).catch((err) => console.error("Scheduler cycle error:", err));
  }, POLL_INTERVAL_MS);
  await runSchedulerCycle(registry);

  // Materializes due recurring-schedule occurrences into scheduled_posts —
  // a sibling job to runSchedulerCycle(), not a replacement. Runs on a much
  // slower cadence: it fills a 7-day rolling window, so it doesn't need
  // scheduler.ts's 30-second responsiveness, and running it that often
  // would just mean 7 days' worth of near-identical no-op queries.
  const RECURRING_GENERATION_INTERVAL_MS = 15 * 60_000;
  setInterval(() => {
    generateDuePosts().catch((err) => console.error("Recurring schedule generation error:", err));
  }, RECURRING_GENERATION_INTERVAL_MS);
  await generateDuePosts();
}

main();
