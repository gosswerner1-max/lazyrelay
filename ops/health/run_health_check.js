#!/usr/bin/env node
// Runs every Health & Safety check (see HEALTH_KNOWLEDGE.md) and prints a
// JSON result. Intended to be run by the lazyrelay-health-check-daily
// scheduled task, which reads the "overall" field to decide whether to
// alert Slack — this script itself never sends alerts or takes any action,
// it only reports.

const { getSupabaseClient } = require("../shared/supabaseClient.js");
const { gatherStorageUsage } = require("../shared/storageUsage.js");
const { runAllChecks } = require("./health_ops.js");

async function main() {
  const supabase = getSupabaseClient();

  // Storage usage is fetched separately (not inside runAllChecks) but a
  // failure here must not abort the whole run and produce zero results
  // (real incident 2026-09-22: a Supabase 522 here killed 3 runs outright).
  // Failure is instead surfaced as its own failed check by checkStorageOverage.
  let storageUsage = null;
  let storageUsageError = null;
  try {
    storageUsage = await gatherStorageUsage(supabase);
  } catch (err) {
    storageUsageError = err.message || String(err);
  }

  const { overall, results } = await runAllChecks(supabase, storageUsage, storageUsageError);

  console.log(JSON.stringify({ overall, checkedAt: new Date().toISOString(), results }, null, 2));

  if (overall === "critical") process.exitCode = 2;
  else if (overall === "warn") process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
