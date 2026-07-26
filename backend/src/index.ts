import "dotenv/config";
import { supabase } from "./supabase.js";
import { runSchedulerCycle } from "./scheduler.js";
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

  // TikTok, Pinterest, and YouTube are all real PlatformAdapters now (see
  // project-platform-app-registration memory), but only one PlatformAdapter
  // is wired app-wide at a time (buildApp/runSchedulerCycle both take a
  // single adapter, not a per-platform registry) — a real registry is
  // future work now that a third adapter makes the single-slot limit
  // actually bite. ACTIVE_PLATFORM picks which one is live; defaulting to
  // "tiktok" keeps prod behavior unchanged for anyone who hasn't set the
  // flag. Meta/X/Reddit stay on the stub until their own real adapters
  // are built.
  const activePlatform = process.env.ACTIVE_PLATFORM ?? "tiktok";
  let platformAdapter: PlatformAdapter = new StubAdapter();
  if (
    activePlatform === "tiktok" &&
    process.env.TIKTOK_CLIENT_KEY &&
    process.env.TIKTOK_CLIENT_SECRET &&
    process.env.TIKTOK_REDIRECT_URI
  ) {
    platformAdapter = new TikTokAdapter(
      process.env.TIKTOK_CLIENT_KEY,
      process.env.TIKTOK_CLIENT_SECRET,
      process.env.TIKTOK_REDIRECT_URI,
    );
  } else if (
    activePlatform === "pinterest" &&
    process.env.PINTEREST_APP_ID &&
    process.env.PINTEREST_APP_SECRET &&
    process.env.PINTEREST_REDIRECT_URI
  ) {
    platformAdapter = new PinterestAdapter(
      process.env.PINTEREST_APP_ID,
      process.env.PINTEREST_APP_SECRET,
      process.env.PINTEREST_REDIRECT_URI,
    );
  } else if (
    activePlatform === "youtube" &&
    process.env.YOUTUBE_CLIENT_ID &&
    process.env.YOUTUBE_CLIENT_SECRET &&
    process.env.YOUTUBE_REDIRECT_URI
  ) {
    platformAdapter = new YouTubeAdapter(
      process.env.YOUTUBE_CLIENT_ID,
      process.env.YOUTUBE_CLIENT_SECRET,
      process.env.YOUTUBE_REDIRECT_URI,
    );
  } else if (activePlatform === "mastodon" && process.env.MASTODON_REDIRECT_URI) {
    // No client id/secret env vars — Mastodon app registration is
    // self-service and instant (POST /api/v1/apps), so the adapter
    // registers itself against its default instance on first use rather
    // than requiring pre-provisioned credentials like every other platform.
    platformAdapter = new MastodonAdapter(process.env.MASTODON_REDIRECT_URI);
  } else if (activePlatform === "bluesky" && process.env.BLUESKY_CONNECT_PAGE_URL) {
    // No client id/secret — this adapter uses app passwords, not OAuth
    // (see platforms/bluesky.ts), so the only real config it needs is
    // where LazyRelay's own connect-form page lives.
    platformAdapter = new BlueskyAdapter(process.env.BLUESKY_CONNECT_PAGE_URL);
  } else if (activePlatform === "telegram" && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CONNECT_PAGE_URL) {
    // No OAuth at all — TELEGRAM_BOT_TOKEN authenticates every call as the
    // one shared @lazyrelay_bot; TELEGRAM_LOG_CHAT_ID is optional but
    // strongly recommended (see platforms/telegram.ts) for real per-message
    // Proof-of-Publish verification instead of a degraded channel-only check.
    platformAdapter = new TelegramAdapter(
      process.env.TELEGRAM_BOT_TOKEN,
      process.env.TELEGRAM_CONNECT_PAGE_URL,
      process.env.TELEGRAM_LOG_CHAT_ID,
    );
  } else if (
    activePlatform === "linkedin" &&
    process.env.LINKEDIN_CLIENT_ID &&
    process.env.LINKEDIN_CLIENT_SECRET &&
    process.env.LINKEDIN_REDIRECT_URI
  ) {
    platformAdapter = new LinkedInAdapter(
      process.env.LINKEDIN_CLIENT_ID,
      process.env.LINKEDIN_CLIENT_SECRET,
      process.env.LINKEDIN_REDIRECT_URI,
    );
  } else if (
    activePlatform === "threads" &&
    process.env.THREADS_APP_ID &&
    process.env.THREADS_APP_SECRET &&
    process.env.THREADS_REDIRECT_URI
  ) {
    platformAdapter = new ThreadsAdapter(
      process.env.THREADS_APP_ID,
      process.env.THREADS_APP_SECRET,
      process.env.THREADS_REDIRECT_URI,
    );
  } else if (
    activePlatform === "facebook" &&
    process.env.META_APP_ID &&
    process.env.META_APP_SECRET &&
    process.env.META_REDIRECT_URI
  ) {
    platformAdapter = new FacebookAdapter(
      process.env.META_APP_ID,
      process.env.META_APP_SECRET,
      process.env.META_REDIRECT_URI,
    );
  } else if (
    activePlatform === "instagram" &&
    process.env.META_APP_ID &&
    process.env.META_APP_SECRET &&
    process.env.META_REDIRECT_URI
  ) {
    platformAdapter = new InstagramAdapter(
      process.env.META_APP_ID,
      process.env.META_APP_SECRET,
      process.env.META_REDIRECT_URI,
    );
  } else if (activePlatform === "discord" && process.env.DISCORD_CONNECT_PAGE_URL) {
    platformAdapter = new DiscordAdapter(process.env.DISCORD_CONNECT_PAGE_URL);
  } else if (
    activePlatform === "tumblr" &&
    process.env.TUMBLR_CLIENT_ID &&
    process.env.TUMBLR_CLIENT_SECRET &&
    process.env.TUMBLR_REDIRECT_URI
  ) {
    platformAdapter = new TumblrAdapter(
      process.env.TUMBLR_CLIENT_ID,
      process.env.TUMBLR_CLIENT_SECRET,
      process.env.TUMBLR_REDIRECT_URI,
    );
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
    `Platform adapter: ${platformAdapter.constructor.name} (platform=${platformAdapter.platform}, ` +
      `ACTIVE_PLATFORM=${activePlatform}); ` +
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
      `TUMBLR_REDIRECT_URI=${process.env.TUMBLR_REDIRECT_URI ? "set" : "MISSING"}`,
  );

  const app = buildApp(morAdapter, platformAdapter);
  app.listen(PORT, () => console.log(`HTTP API listening on :${PORT}`));

  setInterval(() => {
    runSchedulerCycle(platformAdapter).catch((err) => console.error("Scheduler cycle error:", err));
  }, POLL_INTERVAL_MS);
  await runSchedulerCycle(platformAdapter);
}

main();
