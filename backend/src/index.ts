import "dotenv/config";
import { supabase } from "./supabase.js";
import { getAccessToken, runSchedulerCycle } from "./scheduler.js";
import { generateDuePosts } from "./recurringScheduler.js";
import { runTokenRefreshCycle } from "./tokenRefresher.js";
import { runPrivacySweep } from "./privacySweep.js";
import { purgeExpiredConnects } from "./platforms/connect.js";
import { runWebhookDeliveryCycle } from "./webhook.js";
import { runReplySenderCycle } from "./replySender.js";
import { RSS_CHECK_INTERVAL_MS, runRssCycle } from "./rssPoller.js";
import { buildPlatformRegistry } from "./platforms/registry.js";
import { StubMorAdapter } from "./billing/stub.js";
import { PaddleMorAdapter } from "./billing/paddle.js";
import { Environment } from "@paddle/paddle-node-sdk";
import { buildApp } from "./http/app.js";
import { fetchSupabaseOAuthMetadata } from "./http/mcpAuth.js";
import { checkProductionConfig } from "./startupConfigCheck.js";
import { retryStartupCheck } from "./startupRetry.js";
import type { MerchantOfRecordAdapter } from "./billing/types.js";

// How often the scheduler checks for due posts. Combined with scheduler.ts's
// CLAIM_BATCH_SIZE, this sets the real publishing throughput ceiling (see
// that file's comment). Env-configurable so raising throughput later is a
// Render dashboard setting, not a code change — defaults to the original
// hardcoded value, so leaving it unset changes nothing.
const POLL_INTERVAL_MS = Number(process.env.SCHEDULER_POLL_INTERVAL_MS) || 30_000;
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// A transient gateway failure (e.g. Cloudflare fronting Supabase returning a
// 522 during a brief outage) makes supabase-js's error .message the raw HTML
// of the provider's error page, sometimes tens of KB — logged as-is, that
// buries the actual signal ("something failed") under a wall of markup. This
// collapses that specific shape into a one-line summary; anything else logs
// unchanged. Real incident, 2026-09-23: a Supabase compute resize's brief
// restart window did exactly this to the scheduler's own error logs.
function summarizeIfHtmlError(err: unknown): unknown {
  const message = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : null;
  if (!message) return err;
  const looksLikeHtmlErrorPage = /^\s*<(!doctype html|html)/i.test(message) || (message.length > 2000 && /<\/?(html|div|span)[\s>]/i.test(message));
  if (!looksLikeHtmlErrorPage) return err;
  const firstLine = message.trim().split("\n")[0].slice(0, 200);
  return `Non-JSON (HTML) error response, ${message.length} chars — likely a gateway error page from a transient outage. First line: ${firstLine}`;
}

async function main() {
  // Retry with back-off (about 3 minutes in all) so a brief Supabase or
  // network blip does not turn into a crash loop; still exits if it never
  // answers, so a real misconfiguration is not hidden.
  const connected = await retryStartupCheck(
    async () => {
      const { error } = await supabase.from("accounts").select("id").limit(1);
      return error ? { ok: false, error } : { ok: true };
    },
    {
      onFailure: (attempt, total, err, nextDelayMs) =>
        console.error(
          `Supabase connection failed (attempt ${attempt}/${total}${nextDelayMs === null ? ", giving up" : `, retrying in ${nextDelayMs / 1000}s`}):`,
          summarizeIfHtmlError(err),
        ),
    },
  );
  if (!connected) process.exit(1);
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
      `X_BYOK_ENABLED=${process.env.X_BYOK_ENABLED === "true" ? "on" : "off"}; ` +
      `WHATSAPP_BYOK_ENABLED=${process.env.WHATSAPP_BYOK_ENABLED === "true" ? "on" : "off"} ` +
      `WHATSAPP_WEBHOOK_VERIFY_TOKEN=${process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ? "set" : "MISSING"} ` +
      `WHATSAPP_CONTACT_HASH_KEY=${process.env.WHATSAPP_CONTACT_HASH_KEY ? "set" : "MISSING"}; ` +
      `WORDPRESS_CONNECT_PAGE_URL=${process.env.WORDPRESS_CONNECT_PAGE_URL ? "set" : "MISSING"} ` +
      `DEVTO_CONNECT_PAGE_URL=${process.env.DEVTO_CONNECT_PAGE_URL ? "set" : "MISSING"} ` +
      `HASHNODE_CONNECT_PAGE_URL=${process.env.HASHNODE_CONNECT_PAGE_URL ? "set" : "MISSING"} ` +
      `LEMMY_CONNECT_PAGE_URL=${process.env.LEMMY_CONNECT_PAGE_URL ? "set" : "MISSING"}; ` +
      `SLACK_CLIENT_ID=${process.env.SLACK_CLIENT_ID ? "set" : "MISSING"} ` +
      `SLACK_CLIENT_SECRET=${process.env.SLACK_CLIENT_SECRET ? "set" : "MISSING"} ` +
      `SLACK_REDIRECT_URI=${process.env.SLACK_REDIRECT_URI ? "set" : "MISSING"}; ` +
      `NOSTR_CONNECT_PAGE_URL=${process.env.NOSTR_CONNECT_PAGE_URL ? "set" : "MISSING"}; ` +
      `WHOP_APP_API_KEY=${process.env.WHOP_APP_API_KEY ? "set" : "MISSING"} ` +
      `WHOP_APP_ID=${process.env.WHOP_APP_ID ? "set" : "MISSING"}; ` +
      `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "set" : "MISSING"}`,
  );

  // Catches config that's present but WRONG (missing FRONTEND_URL, a
  // leftover Sandbox TikTok key) -- the log line above only ever checked
  // set-vs-missing. See startupConfigCheck.ts.
  await checkProductionConfig();

  // Hosted MCP needs Supabase's OAuth 2.1 server to be enabled on the
  // project (Authentication -> OAuth Server). If it isn't, this returns
  // null with a loud warning and MCP is simply not mounted — the rest of
  // the API is unaffected.
  const mcpOAuthMetadata = await fetchSupabaseOAuthMetadata();

  const app = buildApp(morAdapter, registry, mcpOAuthMetadata);
  app.listen(PORT, () => console.log(`HTTP API listening on :${PORT}`));

  setInterval(() => {
    runSchedulerCycle(registry).catch((err) => console.error("Scheduler cycle error:", summarizeIfHtmlError(err)));
  }, POLL_INTERVAL_MS);
  // This first, immediate call was the one gap the interval version above
  // didn't have: unlike the setInterval callback, it was `await`ed directly
  // inside main() with no .catch() of its own, so a transient failure here
  // (e.g. a query against a column a migration hadn't created yet) became
  // an unhandled rejection — fatal on Node 24 — and crashed the whole
  // process on the very first poll cycle after a fresh deploy. That's
  // exactly what happened 2026-08-30 (see project-calendar-redesign's
  // Phase 0 notes). Same .catch() as the interval version closes it.
  await runSchedulerCycle(registry).catch((err) => console.error("Scheduler cycle error:", summarizeIfHtmlError(err)));

  // Materializes due recurring-schedule occurrences into scheduled_posts —
  // a sibling job to runSchedulerCycle(), not a replacement. Runs on a much
  // slower cadence: it fills a 7-day rolling window, so it doesn't need
  // scheduler.ts's 30-second responsiveness, and running it that often
  // would just mean 7 days' worth of near-identical no-op queries.
  const RECURRING_GENERATION_INTERVAL_MS = 15 * 60_000;
  setInterval(() => {
    generateDuePosts().catch((err) => console.error("Recurring schedule generation error:", summarizeIfHtmlError(err)));
  }, RECURRING_GENERATION_INTERVAL_MS);
  // Renews Threads tokens before they expire and warns customers whose
  // connection (LinkedIn) cannot be renewed automatically. See
  // tokenRefresher.ts. Every 6 hours; the first run is delayed a minute so it
  // never slows boot, and a failure only logs.
  // Webhook retries (webhook.ts): every 30 seconds, pick up deliveries whose next
  // attempt is due. Failures only log; this must never affect posting.
  const WEBHOOK_CYCLE_INTERVAL_MS = 30_000;
  setInterval(() => {
    runWebhookDeliveryCycle().catch((err) => console.error("Webhook delivery cycle error:", summarizeIfHtmlError(err)));
  }, WEBHOOK_CYCLE_INTERVAL_MS);

  // Approved replies (replySender.ts): every 30 seconds, post the replies a person approved in the dashboard. The cycle
  // does nothing unless REPLY_DRAFTS_ENABLED is exactly "true" (off by default), so this timer is inert until then.
  // Failures only log; this must never affect posting.
  const REPLY_SENDER_INTERVAL_MS = 30_000;
  setInterval(() => {
    runReplySenderCycle({ db: supabase, getAdapter: (platform) => registry.get(platform), getToken: getAccessToken }).catch((err) =>
      console.error("Reply sender cycle error:", summarizeIfHtmlError(err)),
    );
  }, REPLY_SENDER_INTERVAL_MS);

  // RSS feeds (rssPoller.ts): new items become drafts, never posts. Every 30
  // minutes; failures only log and can never affect posting.
  const runRssJob = () =>
    runRssCycle()
      .then((r) => {
        if (r.drafts) console.log(`RSS cycle: ${r.drafts} new draft(s) from ${r.checked} feed(s).`);
      })
      .catch((err) => console.error("RSS cycle error:", summarizeIfHtmlError(err)));
  setInterval(runRssJob, RSS_CHECK_INTERVAL_MS);
  setTimeout(runRssJob, 120_000);

  const TOKEN_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
  const runTokenJob = () =>
    purgeExpiredConnects()
      .then((n) => {
        if (n) console.log(`Purged ${n} expired connect flow(s).`);
      })
      .catch((err) => console.error("Connect purge error:", summarizeIfHtmlError(err)))
      .then(() => runTokenRefreshCycle(registry))
      .then((r) => {
        if (r.refreshed || r.flagged || r.warned || r.failed) console.log("Token refresh cycle:", JSON.stringify(r));
      })
      .catch((err) => console.error("Token refresh cycle error:", summarizeIfHtmlError(err)))
      // Privacy sweep (2026-10-07): wipe the stored logins of disconnected accounts, delete comments and DMs outside the
      // 30 day tracking window. See privacySweep.ts.
      .then(() => runPrivacySweep(supabase))
      .then((r) => {
        if (r.tokensWiped || r.tokenFailures || r.commentsDeleted || r.dmsDeleted || r.messagesDeleted || r.purgeFailed) console.log("Privacy sweep:", JSON.stringify(r));
      })
      .catch((err) => console.error("Privacy sweep error:", summarizeIfHtmlError(err)));
  setInterval(runTokenJob, TOKEN_REFRESH_INTERVAL_MS);
  setTimeout(runTokenJob, 60_000);

  // Same gap as runSchedulerCycle's initial call above, same fix.
  await generateDuePosts().catch((err) => console.error("Recurring schedule generation error:", summarizeIfHtmlError(err)));
}

main();
