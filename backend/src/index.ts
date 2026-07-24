import "dotenv/config";
import { supabase } from "./supabase.js";
import { runSchedulerCycle } from "./scheduler.js";
import { StubAdapter } from "./platforms/stub.js";
import { TikTokAdapter } from "./platforms/tiktok.js";
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

  // TikTok is the first real PlatformAdapter (Content Posting API, Sandbox
  // mode — see project-platform-app-registration memory). Meta/Pinterest/X/
  // YouTube stay on the stub until their own real adapters are built; only
  // one PlatformAdapter is wired app-wide at a time (buildApp/runSchedulerCycle
  // both take a single adapter, not a per-platform registry).
  const platformAdapter: PlatformAdapter =
    process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET && process.env.TIKTOK_REDIRECT_URI
      ? new TikTokAdapter(
          process.env.TIKTOK_CLIENT_KEY,
          process.env.TIKTOK_CLIENT_SECRET,
          process.env.TIKTOK_REDIRECT_URI,
        )
      : new StubAdapter();
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
    `Platform adapter: ${platformAdapter.constructor.name} (platform=${platformAdapter.platform}); ` +
      `TIKTOK_CLIENT_KEY=${process.env.TIKTOK_CLIENT_KEY ? "set" : "MISSING"} ` +
      `TIKTOK_CLIENT_SECRET=${process.env.TIKTOK_CLIENT_SECRET ? "set" : "MISSING"} ` +
      `TIKTOK_REDIRECT_URI=${process.env.TIKTOK_REDIRECT_URI ? "set" : "MISSING"}`,
  );

  const app = buildApp(morAdapter, platformAdapter);
  app.listen(PORT, () => console.log(`HTTP API listening on :${PORT}`));

  setInterval(() => {
    runSchedulerCycle(platformAdapter).catch((err) => console.error("Scheduler cycle error:", err));
  }, POLL_INTERVAL_MS);
  await runSchedulerCycle(platformAdapter);
}

main();
