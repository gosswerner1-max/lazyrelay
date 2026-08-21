// Helper for test-batch-size-config.ts — a genuinely separate process so
// SCHEDULER_CLAIM_BATCH_SIZE is set in the environment before this process
// (and its import of scheduler.js) even starts, matching how Render sets
// env vars in reality. Not meant to be run directly.
import "dotenv/config";
import { runSchedulerCycle } from "./scheduler.js";
import { StubAdapter } from "./platforms/stub.js";

const stubAdapter = new StubAdapter();
await runSchedulerCycle(new Map([[stubAdapter.platform, stubAdapter]]));
