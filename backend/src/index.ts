import "dotenv/config";
import { supabase } from "./supabase.js";
import { runSchedulerCycle } from "./scheduler.js";
import { generateDuePosts } from "./recurringScheduler.js";
import { buildPlatformRegistry } from "./platforms/registry.js";
import { StubMorAdapter } from "./billing/stub.js";
import { PaddleMorAdapter } from "./billing/paddle.js";
import { Environment } from "@paddle/paddle-node-sdk";
import { buildApp } from "./http/app.js";
import { fetchSupabaseOAuthMetadata } from "./http/mcpAuth.js";
import type { MerchantOfRecordAdapter } from "./billing/types.js";

// How often the scheduler checks for due posts. Combined with scheduler.ts's
// CLAIM_BATCH_SIZE, this sets the real publishing throughput ceiling (see
// that file's comment). Env-configurable so raising throughput later is a
// Render dashboard setting, not a code change — defaults to the original
// hardcoded value, so leaving it unset changes nothing.
const POLL_INTERVAL_MS = Number(process.env.SCHEDULER_POLL_INTERVAL_MS) || 30_000;
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

async function main() {
  const { error } = await supabase.from("accounts").select("id").limit(1);
  if (error) {
    console.error("Supabase connection failed:", error.message);
    process.exit(1);
  }
  console.log("Connected to Supabase.");

  // Every configured platform gets its own live PlatformAdapter in the
  // registry (Map<platform, adapter>). A platform whose env vars aren't set
  // simply isn't in the map — /api/platforms reports it as unconfigured
  // rather than silently falling back to a stub. Construction logic lives in
  // platforms/registry.ts (extracted 2026-08-07) so the metrics poller
  // script can build the identical registry without a second copy.
  const registry = buildPlatformRegistry();
  const hasRealMorCredentials = Boolean(process.env.MOR_API_KEY && process.env.MOR_WEBHOOK_SECRET);
  // StubMorAdapter.parseWebhookEvent() does no signature verification at
  // all — it trusts every field in the raw body, including `tier`. Falling
  // back to it silently is fine in sandbox/dev (nothing there grants real
  // access), but in production it would turn POST /api/webhooks/mor into a
  // fully unauthenticated "grant this account any tier" endpoint if the
  // real credentials are ever missing (e.g. dropped during a redeploy or
  // secret rotation) — refuse to boot instead of serving that silently.
  if (process.env.PADDLE_ENVIRONMENT === "production" && !hasRealMorCredentials) {
    console.error(
      "PADDLE_ENVIRONMENT is production but MOR_API_KEY/MOR_WEBHOOK_SECRET are missing — refusing to boot with an unauthenticated billing webhook. Set both, or unset PADDLE_ENVIRONMENT if this is intentionally a non-production deploy.",
    );
    process.exit(1);
  }
  const morAdapter: MerchantOfRecordAdapter = hasRealMorCredentials
    ? new PaddleMorAdapter(
        process.env.MOR_API_KEY!,
        process.env.MOR_WEBHOOK_SECRET!,
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
      `SNAPCHAT_CLIENT_ID=${process.env.SNAPCHAT_CLIENT_ID ? "set" : "MISSING"} ` +
      `SNAPCHAT_CLIENT_SECRET=${process.env.SNAPCHAT_CLIENT_SECRET ? "set" : "MISSING"} ` +
      `SNAPCHAT_REDIRECT_URI=${process.env.SNAPCHAT_REDIRECT_URI ? "set" : "MISSING"}; ` +
      `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "set" : "MISSING"}`,
  );

  // Hosted MCP needs Supabase's OAuth 2.1 server to be enabled on the
  // project (Authentication -> OAuth Server). If it isn't, this returns
  // null with a loud warning and MCP is simply not mounted — the rest of
  // the API is unaffected.
  const mcpOAuthMetadata = await fetchSupabaseOAuthMetadata();

  const app = buildApp(morAdapter, registry, mcpOAuthMetadata);
  app.listen(PORT, () => console.log(`HTTP API listening on :${PORT}`));

  setInterval(() => {
    runSchedulerCycle(registry).catch((err) => console.error("Scheduler cycle error:", err));
  }, POLL_INTERVAL_MS);
  // This first, immediate call was the one gap the interval version above
  // didn't have: unlike the setInterval callback, it was `await`ed directly
  // inside main() with no .catch() of its own, so a transient failure here
  // (e.g. a query against a column a migration hadn't created yet) became
  // an unhandled rejection — fatal on Node 24 — and crashed the whole
  // process on the very first poll cycle after a fresh deploy. That's
  // exactly what happened 2026-08-30 (see project-calendar-redesign's
  // Phase 0 notes). Same .catch() as the interval version closes it.
  await runSchedulerCycle(registry).catch((err) => console.error("Scheduler cycle error:", err));

  // Materializes due recurring-schedule occurrences into scheduled_posts —
  // a sibling job to runSchedulerCycle(), not a replacement. Runs on a much
  // slower cadence: it fills a 7-day rolling window, so it doesn't need
  // scheduler.ts's 30-second responsiveness, and running it that often
  // would just mean 7 days' worth of near-identical no-op queries.
  const RECURRING_GENERATION_INTERVAL_MS = 15 * 60_000;
  setInterval(() => {
    generateDuePosts().catch((err) => console.error("Recurring schedule generation error:", err));
  }, RECURRING_GENERATION_INTERVAL_MS);
  // Same gap as runSchedulerCycle's initial call above, same fix.
  await generateDuePosts().catch((err) => console.error("Recurring schedule generation error:", err));
}

main();
