// Behaviour check of migration 0139 on PGlite (a real Postgres engine in WASM). A LOCAL draft helper: the public repository has no SQL test
// harness, so this borrows PGlite from the private service repository's node_modules by absolute path. Run from the repo root:
//   node backend/scripts/wallet-sql-check.mjs
// It builds Supabase like roles and a stand in for is_account_member(), applies the migration (twice, to prove it is idempotent), then
// attacks it. Exits 1 on the first failed expectation.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const { PGlite } = await import(pathToFileURL("C:/Users/werne/Claude/lazyrelay-content-sources/node_modules/@electric-sql/pglite/dist/index.js").href);
const MIGRATION = readFileSync(new URL("../supabase/migrations/0139_wallet_ledger.sql", import.meta.url), "utf8");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const db = new PGlite();
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant anon, authenticated, service_role to current_user;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  create table public.accounts (id uuid primary key, created_at timestamptz not null default now());
  create table public.account_members (user_id uuid not null, account_id uuid not null);
  create function public.is_account_member(p uuid) returns boolean language sql stable security definer as $$ select exists (select 1 from public.account_members m where m.account_id = p and m.user_id = auth.uid()) $$;
  grant execute on function public.is_account_member(uuid) to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  insert into public.accounts values ('${A}'), ('${B}');
  insert into public.account_members values ('${USER_A}', '${A}');
`);
await db.exec(MIGRATION);
await db.exec(MIGRATION); // twice: must be idempotent

let passed = 0;
const log = [];
async function expect(name, fn) {
  try {
    const out = await fn();
    if (out !== true) throw new Error(`expectation false (${JSON.stringify(out)})`);
    passed += 1;
    log.push({ check: name, result: "pass" });
  } catch (e) {
    log.push({ check: name, result: `FAIL: ${e.message}` });
    console.table(log);
    process.exit(1);
  }
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
async function fails(sql, code, params) {
  try {
    await db.query(sql, params);
  } catch (e) {
    return e.code === code ? true : `wrong code ${e.code}: ${e.message}`;
  }
  return "no error";
}
async function asRole(role, sub, sql, params) {
  await db.exec("begin");
  try {
    await db.exec(`set local role ${role}`);
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [sub ? JSON.stringify({ sub }) : "{}"]);
    return await db.query(sql, params);
  } finally {
    await db.exec("rollback").catch(() => undefined);
    await db.exec("reset role").catch(() => undefined);
  }
}
async function deniedAs(role, sub, sql, params) {
  try {
    await asRole(role, sub, sql, params);
  } catch (e) {
    return e.code === "42501" ? true : `wrong code ${e.code}: ${e.message}`;
  }
  return "no error";
}
const charge = (acc, action, units, key) => one(`select public.wallet_charge($1::uuid, $2, $3, $4) as r`, [acc, action, units, key]).then((x) => x.r);
const credit = (acc, micro, key, ref, kind) => one(`select public.wallet_credit($1::uuid, $2::bigint, $3, $4, $5) as r`, [acc, micro, key, ref ?? null, kind ?? "top_up"]).then((x) => x.r);
const balance = async (acc) => Number((await one(`select balance_micro from public.wallet_accounts where account_id = $1`, [acc]))?.balance_micro ?? 0);
const ledgerCount = async (acc) => Number((await one(`select count(*) as n from public.wallet_ledger where account_id = $1`, [acc])).n);

await expect("prices are seeded exactly: api_dispatch 2000, sitemap_sync 50000 (0.002 and 0.05 USD)", async () => {
  const rows = (await db.query(`select action_type, price_micro::int as p from public.wallet_prices order by 1`)).rows;
  return JSON.stringify(rows) === JSON.stringify([{ action_type: "api_dispatch", p: 2000 }, { action_type: "sitemap_sync", p: 50000 }]);
});
await expect("a charge on an empty wallet is refused with insufficient_funds and writes nothing", async () => {
  const r = await charge(A, "api_dispatch", 1, "k0");
  return r.ok === false && r.reason === "insufficient_funds" && r.required_micro === 2000 && (await ledgerCount(A)) === 0 && (await balance(A)) === 0;
});
await expect("a credit of 5,000,000 micro (5 USD) lands and is logged", async () => {
  const r = await credit(A, 5_000_000, "topup-1", "paddle:txn_1");
  return r.ok && r.balance_micro === 5_000_000 && (await ledgerCount(A)) === 1;
});
await expect("a dispatch charge takes exactly 2,000 and a sitemap sync exactly 50,000", async () => {
  const a = await charge(A, "api_dispatch", 1, "c1");
  const b = await charge(A, "sitemap_sync", 1, "c2");
  return a.charged_micro === 2000 && b.charged_micro === 50000 && (await balance(A)) === 5_000_000 - 52_000;
});
await expect("units multiply the price: 10 dispatches cost 20,000", async () => (await charge(A, "api_dispatch", 10, "c3")).charged_micro === 20000);
await expect("the same key again is a replay: same answer, nothing charged twice", async () => {
  const before = await balance(A);
  const n = await ledgerCount(A);
  const r = await charge(A, "api_dispatch", 1, "c1");
  return r.replay === true && r.charged_micro === 2000 && (await balance(A)) === before && (await ledgerCount(A)) === n;
});
await expect("the same key for a different change is refused (unique_violation)", async () => (await fails(`select public.wallet_charge('${A}', 'sitemap_sync', 1, 'c1')`, "23505")) === true);
await expect("a replayed credit is not credited twice", async () => {
  const before = await balance(A);
  const r = await credit(A, 5_000_000, "topup-1", "paddle:txn_1");
  return r.replay === true && (await balance(A)) === before;
});
for (const [name, sql] of [
  ["a credit of zero is refused", `select public.wallet_credit('${A}', 0, 'z1')`],
  ["a negative credit is refused (no minting credit)", `select public.wallet_credit('${A}', -1000, 'z2')`],
  ["a credit above the limit is refused", `select public.wallet_credit('${A}', 1000000000001, 'z3')`],
  ["a credit kind other than top_up or refund is refused", `select public.wallet_credit('${A}', 1000, 'z4', null, 'charge')`],
  ["zero units is refused", `select public.wallet_charge('${A}', 'api_dispatch', 0, 'z5')`],
  ["negative units is refused (no minting credit through a charge)", `select public.wallet_charge('${A}', 'api_dispatch', -5, 'z6')`],
  ["10,001 units is refused", `select public.wallet_charge('${A}', 'api_dispatch', 10001, 'z7')`],
  ["an unknown action is refused", `select public.wallet_charge('${A}', 'free_money', 1, 'z8')`],
  ["a missing key is refused", `select public.wallet_charge('${A}', 'api_dispatch', 1, null)`],
  ["an empty key is refused", `select public.wallet_charge('${A}', 'api_dispatch', 1, '')`],
  ["a key over 128 characters is refused", `select public.wallet_charge('${A}', 'api_dispatch', 1, '${"k".repeat(129)}')`],
]) await expect(name, async () => (await fails(sql, "22023")) === true);

await expect("the ledger cannot be updated", async () => (await fails(`update public.wallet_ledger set delta_micro = 1`, "42501")) === true);
await expect("the ledger cannot be deleted from", async () => (await fails(`delete from public.wallet_ledger`, "42501")) === true);
await expect("the ledger cannot be truncated", async () => (await fails(`truncate public.wallet_ledger`, "42501")) === true);
await expect("even the table owner cannot push a balance below zero (check constraint)", async () => (await fails(`update public.wallet_accounts set balance_micro = -1`, "23514")) === true);

await expect("service_role cannot edit a balance directly", async () => (await deniedAs("service_role", null, `update public.wallet_accounts set balance_micro = 999999999`)) === true);
await expect("service_role cannot insert a ledger row directly", async () => (await deniedAs("service_role", null, `insert into public.wallet_ledger (account_id, kind, delta_micro, balance_after_micro, idempotency_key) values ('${A}', 'top_up', 1, 1, 'direct')`)) === true);
await expect("service_role cannot change a price", async () => (await deniedAs("service_role", null, `update public.wallet_prices set price_micro = 1`)) === true);
await expect("service_role can read, and can run the functions", async () => {
  const read = await asRole("service_role", null, `select count(*)::int as n from public.wallet_ledger`);
  const ran = await asRole("service_role", null, `select public.wallet_charge('${A}', 'api_dispatch', 1, 'svc-1') as r`);
  return read.rows[0].n > 0 && ran.rows[0].r.ok === true;
});
await expect("anon cannot read the wallet or run the functions", async () => {
  return (await deniedAs("anon", null, `select * from public.wallet_accounts`)) === true && (await deniedAs("anon", null, `select public.wallet_charge('${A}', 'api_dispatch', 1, 'anon-1')`)) === true;
});
await expect("a signed in customer cannot run the functions or write any wallet table", async () => {
  return (
    (await deniedAs("authenticated", USER_A, `select public.wallet_credit('${A}', 1000000, 'self-top-up')`)) === true &&
    (await deniedAs("authenticated", USER_A, `select public.wallet_charge('${A}', 'api_dispatch', 1, 'self')`)) === true &&
    (await deniedAs("authenticated", USER_A, `update public.wallet_accounts set balance_micro = 999999999`)) === true &&
    (await deniedAs("authenticated", USER_A, `insert into public.wallet_ledger (account_id, kind, delta_micro, balance_after_micro, idempotency_key) values ('${A}', 'top_up', 1, 1, 'x')`)) === true
  );
});
await expect("a member sees their own account's balance and ledger, and not another account's", async () => {
  await credit(B, 1_000_000, "b-top", "x");
  const mine = await asRole("authenticated", USER_A, `select account_id from public.wallet_accounts`);
  const ledger = await asRole("authenticated", USER_A, `select distinct account_id from public.wallet_ledger`);
  return mine.rows.length === 1 && mine.rows[0].account_id === A && ledger.rows.length === 1 && ledger.rows[0].account_id === A;
});
await expect("a stranger sees nothing", async () => (await asRole("authenticated", "99999999-9999-4999-8999-999999999999", `select * from public.wallet_ledger`)).rows.length === 0);

await expect("a signup allowance of 500,000 micro (0.50 USD) is a grant, lands once, and a replay does nothing", async () => {
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await db.query(`insert into public.accounts values ($1)`, [C]);
  const first = await credit(C, 500_000, `signup-grant:${C}`, "signup allowance", "grant");
  const again = await credit(C, 500_000, `signup-grant:${C}`, "signup allowance", "grant");
  const kinds = (await db.query(`select kind from public.wallet_ledger where account_id = $1`, [C])).rows.map((r) => r.kind);
  return first.balance_micro === 500_000 && again.replay === true && JSON.stringify(kinds) === JSON.stringify(["grant"]);
});
await expect("an Enterprise monthly bundle of 10,000,000 micro (10 USD) deposits once per period and again next period", async () => {
  const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await db.query(`insert into public.accounts values ($1)`, [D]);
  await credit(D, 10_000_000, "bundle:sub_01abc:2026-11-19", "sub_01abc", "grant");
  await credit(D, 10_000_000, "bundle:sub_01abc:2026-11-19", "sub_01abc", "grant");
  const mid = await balance(D);
  await credit(D, 10_000_000, "bundle:sub_01abc:2026-12-19", "sub_01abc", "grant");
  return mid === 10_000_000 && (await balance(D)) === 20_000_000;
});
await expect("paused accounts: only a wallet below the cheapest action (balance under 2,000) is listed", async () => {
  const E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const F = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const G = "99999999-9999-4999-8999-999999999999";
  await db.query(`insert into public.accounts values ($1), ($2), ($3)`, [E, F, G]);
  await credit(E, 4000, "e-top"); // 4,000: affords two dispatches
  await charge(E, "api_dispatch", 1, "e1");
  await charge(E, "api_dispatch", 1, "e2"); // now exactly 0
  await credit(F, 2000, "f-top"); // exactly the cheapest price: not paused
  await credit(F, 1, "f-extra"); // 2001
  await charge(F, "api_dispatch", 1, "f1"); // now 1: below the cheapest price, paused
  await credit(G, 5000, "g-top"); // 5,000: fine
  const paused = (await db.query(`select * from public.wallet_paused_account_ids(2000) as id`)).rows.map((r) => r.id);
  return paused.includes(E) && paused.includes(F) && !paused.includes(G) && !paused.includes(A);
});
await expect("an account with NO wallet row is never listed as paused", async () => {
  const H = "12121212-1212-4212-8212-121212121212";
  await db.query(`insert into public.accounts values ($1)`, [H]);
  return !(await db.query(`select * from public.wallet_paused_account_ids(2000) as id`)).rows.map((r) => r.id).includes(H);
});
await expect("wallet_paused_account_ids refuses a minimum of zero or less", async () => (await fails(`select * from public.wallet_paused_account_ids(0)`, "22023")) === true);
await expect("only the backend can ask who is paused: anon and signed in customers are refused", async () => {
  return (await deniedAs("anon", null, `select * from public.wallet_paused_account_ids(2000)`)) === true && (await deniedAs("authenticated", USER_A, `select * from public.wallet_paused_account_ids(2000)`)) === true;
});
const L1 = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const L2 = "a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2";
const N1 = "a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3";
await db.query(`insert into public.accounts (id, created_at) values ($1, '2026-01-01T00:00:00Z'), ($2, '2026-06-01T00:00:00Z'), ($3, now())`, [L1, L2, N1]);
await expect("the snapshot grandfathers exactly the accounts created before the cutoff, and not a newer one", async () => {
  const added = (await one(`select public.wallet_grandfather_accounts('2026-10-01T00:00:00Z') as n`)).n;
  const ids = (await db.query(`select account_id from public.wallet_legacy_accounts`)).rows.map((r) => r.account_id);
  return added === 2 && ids.includes(L1) && ids.includes(L2) && !ids.includes(N1) && !ids.includes(A);
});
await expect("running the snapshot again adds nobody", async () => (await one(`select public.wallet_grandfather_accounts('2026-10-01T00:00:00Z') as n`)).n === 0);
await expect("a cutoff in the future is refused (it would exempt people who have not signed up)", async () => (await fails(`select public.wallet_grandfather_accounts(now() + interval '2 days')`, "22023")) === true);
await expect("a missing cutoff is refused", async () => (await fails(`select public.wallet_grandfather_accounts(null)`, "22023")) === true);
await expect("a grandfathered account is never charged: exempt answer, no wallet row, no ledger row", async () => {
  const r = await charge(L1, "api_dispatch", 5, "legacy-1");
  const wallets = (await db.query(`select 1 from public.wallet_accounts where account_id = $1`, [L1])).rows.length;
  return r.ok === true && r.exempt === true && r.charged_micro === 0 && wallets === 0 && (await ledgerCount(L1)) === 0;
});
await expect("a grandfathered account is never paused, even with a balance below the cheapest action", async () => {
  await credit(L2, 1000, "l2-top");
  return !(await db.query(`select * from public.wallet_paused_account_ids(2000) as id`)).rows.map((r) => r.id).includes(L2);
});
await expect("control: a NEW account with the same balance IS paused", async () => {
  await credit(N1, 1000, "n1-top");
  return (await db.query(`select * from public.wallet_paused_account_ids(2000) as id`)).rows.map((r) => r.id).includes(N1);
});
await expect("a new account is charged normally", async () => {
  await credit(N1, 5000, "n1-top2");
  const r = await charge(N1, "api_dispatch", 1, "n1-c1");
  return r.ok === true && !r.exempt && r.charged_micro === 2000;
});
await expect("only the backend can take the snapshot or write the legacy list", async () => {
  return (
    (await deniedAs("anon", null, `select public.wallet_grandfather_accounts('2026-10-01T00:00:00Z')`)) === true &&
    (await deniedAs("authenticated", USER_A, `select public.wallet_grandfather_accounts('2026-10-01T00:00:00Z')`)) === true &&
    (await deniedAs("service_role", null, `insert into public.wallet_legacy_accounts (account_id, cutoff) values ('${N1}', now())`)) === true &&
    (await deniedAs("authenticated", USER_A, `select * from public.wallet_legacy_accounts`)) === true
  );
});
await expect("2,000 random charges and credits: the balance never goes below zero, equals the sum of the ledger, and the running balances chain", async () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 2000; i++) {
    if (rnd() < 0.25) await credit(B, 1000 + Math.floor(rnd() * 100_000), `rt-c-${i}`);
    else await charge(B, rnd() < 0.8 ? "api_dispatch" : "sitemap_sync", 1 + Math.floor(rnd() * 3), `rt-d-${i}`);
  }
  const bal = await balance(B);
  const sum = Number((await one(`select coalesce(sum(delta_micro),0)::bigint as s from public.wallet_ledger where account_id = $1`, [B])).s);
  const rows = (await db.query(`select delta_micro::bigint as d, balance_after_micro::bigint as b from public.wallet_ledger where account_id = $1 order by id`, [B])).rows;
  let run = 0;
  for (const r of rows) {
    run += Number(r.d);
    if (run !== Number(r.b) || run < 0) return `chain broke at balance ${run} vs ${r.b}`;
  }
  return bal >= 0 && bal === sum;
});

console.table(log);
console.log(`WALLET SQL CHECK: ${passed} of ${log.length} checks passed`);
