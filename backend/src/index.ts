import "dotenv/config";
import { supabase } from "./supabase.js";
import { runSchedulerCycle } from "./scheduler.js";
import { StubAdapter } from "./platforms/stub.js";
import { TikTokAdapter } from "./platforms/tiktok.js";
import { PinterestAdapter } from "./platforms/pinterest.js";
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

  // TikTok and Pinterest are both real PlatformAdapters now (Content Posting
  // API Sandbox / Trial access — see project-platform-app-registration
  // memory), but only one PlatformAdapter is wired app-wide at a time
  // (buildApp/runSchedulerCycle both take a single adapter, not a per-
  // platform registry) — a real registry is future work once a third
  // adapter makes the single-slot limit actually bite. ACTIVE_PLATFORM picks
  // which one is live; defaulting to "tiktok" keeps prod behavior unchanged
  // for anyone who hasn't set the flag. Meta/X/YouTube stay on the stub
  // until their own real adapters are built.
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
      `PINTEREST_REDIRECT_URI=${process.env.PINTEREST_REDIRECT_URI ? "set" : "MISSING"}`,
  );

  const app = buildApp(morAdapter, platformAdapter);
  app.listen(PORT, () => console.log(`HTTP API listening on :${PORT}`));

  setInterval(() => {
    runSchedulerCycle(platformAdapter).catch((err) => console.error("Scheduler cycle error:", err));
  }, POLL_INTERVAL_MS);
  await runSchedulerCycle(platformAdapter);
}

main();
