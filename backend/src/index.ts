import "dotenv/config";
import { supabase } from "./supabase.js";
import { runSchedulerCycle } from "./scheduler.js";
import { StubAdapter } from "./platforms/stub.js";
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

  // Platform adapter stays stubbed until Phase 0 (Meta/TikTok/Pinterest
  // dev apps) is unblocked. Billing switches to the real PaddleMorAdapter
  // automatically the moment real credentials exist in .env — no further
  // code change needed when that happens (see BILLING_KNOWLEDGE.md).
  const platformAdapter = new StubAdapter();
  const morAdapter: MerchantOfRecordAdapter =
    process.env.MOR_API_KEY && process.env.MOR_WEBHOOK_SECRET
      ? new PaddleMorAdapter(
          process.env.MOR_API_KEY,
          process.env.MOR_WEBHOOK_SECRET,
          process.env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox
        )
      : new StubMorAdapter();
  console.log(`Billing adapter: ${morAdapter.constructor.name}`);

  const app = buildApp(morAdapter, platformAdapter);
  app.listen(PORT, () => console.log(`HTTP API listening on :${PORT}`));

  setInterval(() => {
    runSchedulerCycle(platformAdapter).catch((err) => console.error("Scheduler cycle error:", err));
  }, POLL_INTERVAL_MS);
  await runSchedulerCycle(platformAdapter);
}

main();
