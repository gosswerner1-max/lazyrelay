// Real-concurrency check of the wallet functions (migrations 0139 and 0140). PGlite serialises connections, so the PGlite check
// (wallet-lots-sql-check.mjs) cannot prove that parallel callers take turns on the account row lock. This script can, on a real Postgres.
//
// HOW TO RUN (about 2 minutes, then delete the branch)
//   1. Create a THROWAWAY database branch (for example a Supabase branch; it costs about $0.013 an hour). Never use the production database.
//   2. Copy the branch's DIRECT database connection string (or its session mode pooler on port 5432; NOT the transaction mode pooler on
//      6543, which does not keep session settings). Put ?sslmode=require at the end if the branch needs TLS.
//   3. In the shell, set the two variables (the string is never printed or logged; keep it out of shell history if you can):
//        export WALLET_CONCURRENCY_DATABASE_URL='postgres://...'
//        export WALLET_CONCURRENCY_I_AM_A_THROWAWAY_BRANCH=yes
//      Optional: WALLET_CONCURRENCY_FORBIDDEN_HOSTS=host1,host2 refuses those hosts too (any host containing "prod" is always refused).
//   4. From the repository root:   node backend/scripts/wallet-lots-concurrency-check.mjs        (add --connections=12 for more parallelism)
//   5. Read the PASS/FAIL lines. The exit code is 0 only if every check passed. Then delete the branch.
//
// WHAT IT DOES. It opens at least 8 independent connections, creates ONE schema named wl_cc_<12 hex> with two stubs (accounts and
// is_account_member), applies 0139 and 0140 inside that schema (every public. reference is rewritten), runs the checks below, and drops
// the schema. It never touches the public schema or any existing object. It needs the schema owner rights of the connecting role.
//   (a) parallel charges and holds against a balance that covers only some of them: successes never exceed the balance
//   (b) parallel holds, charges and mixed-action holds with the SAME idempotency key: one row, one first answer, conflicts refused
//   (c) parallel commit and release on one hold: exactly one wins, the other is refused cleanly
//   (d) parallel grants with the same source key credit once; parallel signup grants make one lot
//   (e) bursts of charges, holds and wallet_expire around the expiry instant: nothing is spent from or reserved on an expired lot
//   (f) 200 mixed operations from every connection across 3 accounts: no deadlock, no unexpected error
//   (g) afterwards: every ledger chain, balance, lot and reserved total is consistent
//
// --selftest-break=<overdraft|idempotency|expiry|grants|release> (with --selftest) breaks the migration on purpose; the script must then FAIL.
// --selftest runs the same script against a local PGlite socket server. PGlite serialises connections, so that mode validates only the
// script's own logic. It does NOT prove real concurrency, and it says so in its output.
import { createServer } from "node:net";
import { checkGuard, scrub } from "./wallet-lots-concurrency/lib.mjs";
import { breakSql } from "./wallet-lots-concurrency/breaks.mjs";
import { buildFixture, closeAll, dropFixture, makeCtx, openClients } from "./wallet-lots-concurrency/fixture.mjs";
import { checkCommitReleaseRace, checkMixedSizeCharges, checkParallelCharges, checkParallelGrants, checkParallelHolds, checkSameKey } from "./wallet-lots-concurrency/checks-basic.mjs";
import { checkDeadlockFreedom, checkExpiryRace, checkLedgerChains } from "./wallet-lots-concurrency/checks-race.mjs";

const args = process.argv.slice(2);
const selftest = args.includes("--selftest");
const wanted = Number((args.find((a) => a.startsWith("--connections=")) ?? "--connections=8").split("=")[1]);
const breakName = (args.find((a) => a.startsWith("--selftest-break=")) ?? "").split("=")[1];
const connections = Number.isInteger(wanted) && wanted >= 8 && wanted <= 64 ? wanted : 8;

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
  s.on("error", reject);
});

async function startSelftestServer() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const db = await PGlite.create();
  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: connections + 4 });
  await server.start();
  return { url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, stop: async () => { await server.stop(); await db.close(); } };
}

function checkList(ctx) {
  return [
    ["(a1) parallel charges never exceed the balance", () => checkParallelCharges(ctx)],
    ["(a2) mixed size parallel charges never overdraw", () => checkMixedSizeCharges(ctx)],
    ["(a3) parallel holds never reserve more than the balance", () => checkParallelHolds(ctx)],
    ["(b) the same idempotency key in parallel gives one result", () => checkSameKey(ctx)],
    ["(c) commit against release on one hold: exactly one wins", () => checkCommitReleaseRace(ctx)],
    ["(d) parallel grants with one source key credit once", () => checkParallelGrants(ctx)],
    ["(e) a charge racing wallet_expire never spends an expired lot", () => checkExpiryRace(ctx)],
    ["(f) deadlock freedom under mixed load", async () => checkDeadlockFreedom(ctx, [await ctx.newAccount(), await ctx.newAccount(), await ctx.newAccount()])],
    ["(g) the ledger chains are consistent afterwards", () => checkLedgerChains(ctx)],
  ];
}

async function main() {
  let url;
  let stopServer = async () => undefined;
  if (breakName && !selftest) {
    console.error("REFUSED: --selftest-break only works together with --selftest");
    return 2;
  }
  if (selftest) {
    console.log("SELFTEST: PGlite serialises connections. This run validates the script's own logic only. It does NOT prove real concurrency.");
    ({ url, stop: stopServer } = await startSelftestServer());
  } else {
    const guard = checkGuard(process.env);
    if (!guard.ok) {
      console.error(`REFUSED: ${guard.reason}`);
      return 2;
    }
    url = guard.url;
  }
  const secrets = [url];
  let clients = [];
  let schema = null;
  let failed = 0;
  try {
    clients = await openClients(url, connections);
    schema = await buildFixture(clients, { selftest, mutate: breakName ? (sql) => breakSql(sql, breakName) : undefined });
    console.log(`fixture schema built, ${clients.length} independent connections open`);
    const ctx = makeCtx(clients, schema);
    for (const [name, run] of checkList(ctx)) {
      const started = Date.now();
      let r;
      try {
        r = await run();
      } catch (e) {
        r = { pass: false, detail: `error ${e.code ?? ""} ${scrub(e.message ?? "", secrets)}`.trim() };
      }
      if (!r.pass) failed += 1;
      console.log(`${r.pass ? "PASS" : "FAIL"}  ${name}: ${scrub(r.detail, secrets)} [${Date.now() - started} ms]`);
    }
  } catch (e) {
    failed += 1;
    console.error(`FAIL  setup: ${scrub(e.message ?? "error", secrets)}`);
  } finally {
    if (schema && clients.length > 0) await dropFixture(clients, schema).then(() => console.log("fixture schema dropped"), (e) => { failed += 1; console.error(`FAIL  cleanup: ${scrub(e.message ?? "error", secrets)}`); });
    await closeAll(clients);
    await stopServer();
  }
  console.log(failed === 0 ? `ALL CHECKS PASSED${selftest ? " (selftest: script logic only, not real concurrency)" : ""}` : `${failed} CHECK(S) FAILED`);
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
