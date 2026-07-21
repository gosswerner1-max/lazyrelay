import "dotenv/config";
import { supabase } from "./supabase.js";
import { runSchedulerCycle } from "./scheduler.js";
import { StubAdapter } from "./platforms/stub.js";
import { StubMorAdapter } from "./billing/stub.js";
import { buildApp } from "./http/app.js";

const POLL_INTERVAL_MS = 30_000;
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

async function main() {
  const { error } = await supabase.from("accounts").select("id").limit(1);
  if (error) {
    console.error("Supabase connection failed:", error.message);
    process.exit(1);
  }
  console.log("Connected to Supabase.");

  // Stub adapters until Phase 0 (Meta dev app) and the MoR decision are
  // both in place — the scheduler and HTTP routes don't need to change
  // when the real adapters are swapped in later.
  const platformAdapter = new StubAdapter();
  const morAdapter = new StubMorAdapter();

  const app = buildApp(morAdapter, platformAdapter);
  app.listen(PORT, () => console.log(`HTTP API listening on :${PORT}`));

  setInterval(() => {
    runSchedulerCycle(platformAdapter).catch((err) => console.error("Scheduler cycle error:", err));
  }, POLL_INTERVAL_MS);
  await runSchedulerCycle(platformAdapter);
}

main();
