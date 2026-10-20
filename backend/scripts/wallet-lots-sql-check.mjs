// Behaviour check of migration 0140 on PGlite (a real Postgres engine in WASM). A LOCAL helper: the public repository has no SQL test
// service, so PGlite is borrowed by absolute path (override with WALLET_PGLITE). Run from the repo root:
//   node backend/scripts/wallet-lots-sql-check.mjs              all checks (exit 1 on any failure)
//   node backend/scripts/wallet-lots-sql-check.mjs --red        the same checks against NO migration (they must all fail)
//   node backend/scripts/wallet-lots-sql-check.mjs --mutations  breaks the migration on purpose, 1 change at a time, and
//                                                               demands that the checks notice (exit 1 if one slips through)
import { runSuite } from "./wallet-lots-sql/suite.mjs";
import { readMigration0140 } from "./wallet-lots-sql/harness.mjs";
import { MUTATIONS, applyMutation } from "./wallet-lots-sql/mutations.mjs";

const mode = process.argv[2] ?? "";
const sql = readMigration0140();

function show(results) {
  console.table(results.map((r) => ({ check: r.name.slice(0, 150), result: r.ok ? "pass" : `FAIL ${r.detail}`.slice(0, 120) })));
}

async function runMutations() {
  const rows = [];
  for (const m of MUTATIONS) {
    const failing = (await runSuite(applyMutation(sql, m), { randomOps: 300 })).filter((r) => !r.ok).map((r) => r.name);
    const caught = failing.some((n) => n.toLowerCase().includes(m.expect.toLowerCase()));
    rows.push({ mutation: m.name, expectedCheck: m.expect, checksFailing: failing.length, caught });
  }
  console.table(rows);
  const caught = rows.filter((r) => r.caught).length;
  console.log(`WALLET SQL MUTATIONS: ${caught} of ${rows.length} caught by the check they target`);
  process.exit(caught === rows.length ? 0 : 1);
}

if (mode === "--mutations") await runMutations();
else if (mode === "--red") {
  const results = await runSuite("");
  const failed = results.filter((r) => !r.ok).length;
  console.log(`RED RUN (no migration): ${failed} of ${results.length} checks fail`);
  for (const r of results.filter((x) => x.ok)) console.log(`  still passes without 0140 (it tests 0139 behaviour or nothing yet): ${r.name.slice(0, 110)}`);
  process.exit(failed === results.length ? 0 : 1);
} else {
  const results = await runSuite(sql);
  show(results);
  const passed = results.filter((r) => r.ok).length;
  console.log(`WALLET LOTS SQL CHECK: ${passed} of ${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}
