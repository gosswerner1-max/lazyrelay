// Builds the database and runs every check, collecting results instead of stopping at the first failure.
import { freshDb, helpers } from "./harness.mjs";
import { spendChecks, randomCheck } from "./checks-spend.mjs";
import { accessChecks } from "./checks-access.mjs";
import { skuChecks } from "./checks-sku.mjs";

/** @returns {Promise<{name: string, ok: boolean, detail: string}[]>} one entry per check; a migration that will not apply fails them all. */
export async function runSuite(sql0140, { randomOps = 2000 } = {}) {
  let db;
  try {
    db = await freshDb(sql0140);
  } catch (e) {
    return [{ name: "the migration applies twice without error", ok: false, detail: String(e.message).slice(0, 160) }];
  }
  const h = helpers(db);
  const ctx = { db, h, sql: sql0140 };
  const checks = [
    { name: "the migration applies twice without error", fn: async () => true },
    ...spendChecks(ctx),
    randomCheck(ctx, randomOps),
    ...accessChecks(ctx),
    ...skuChecks(ctx),
  ];
  const results = [];
  for (const c of checks) {
    try {
      const out = await c.fn();
      results.push({ name: c.name, ok: out === true, detail: out === true ? "" : String(out).slice(0, 200) });
    } catch (e) {
      results.push({ name: c.name, ok: false, detail: `error: ${String(e.message).slice(0, 160)}` });
    }
  }
  return results;
}
