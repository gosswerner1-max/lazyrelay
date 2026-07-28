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
  const storageUsage = await gatherStorageUsage(supabase);
  const { overall, results } = await runAllChecks(supabase, storageUsage);

  console.log(JSON.stringify({ overall, checkedAt: new Date().toISOString(), results }, null, 2));

  if (overall === "critical") process.exitCode = 2;
  else if (overall === "warn") process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
