// Connections and the throwaway fixture schema of the wallet concurrency check. Nothing outside the schema wl_cc_<12 hex> is touched.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { chainProblem, localizeSql, scrub } from "./lib.mjs";

const MIGRATIONS = ["0139_wallet_ledger.sql", "0140_wallet_credit_lots.sql"];
const mig = (name) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8").replaceAll(String.fromCharCode(13), "");

/** Opens n independent connections. A failure closes the ones already open and throws an error with no connection details in it. */
export async function openClients(url, n) {
  const clients = Array.from({ length: n }, () => new pg.Client({ connectionString: url, application_name: "wallet-concurrency-check", statement_timeout: 60000, lock_timeout: 30000 }));
  const results = await Promise.allSettled(clients.map((c) => c.connect()));
  const failed = results.find((r) => r.status === "rejected");
  if (failed) {
    await closeAll(clients);
    throw new Error(`could not open ${n} connections (${scrub(failed.reason?.code ?? "no code", [url])})`);
  }
  return clients;
}

export async function closeAll(clients) {
  await Promise.allSettled(clients.map((c) => c.end()));
}

/** Creates the fixture schema, the two stubs the migrations need, and applies 0139 and 0140 inside it. selftest also creates the Supabase roles. */
export async function buildFixture(clients, { selftest, mutate = (sql) => sql }) {
  const schema = `wl_cc_${randomBytes(6).toString("hex")}`;
  const c = clients[0];
  if (selftest) {
    await c.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
    end $$`);
  }
  await c.query(`create schema ${schema}`);
  await Promise.all(clients.map((x) => x.query(`set search_path to ${schema}, pg_temp`)));
  await c.query(`create table ${schema}.accounts (id uuid primary key, created_at timestamptz not null default now());
    create function ${schema}.is_account_member(p uuid) returns boolean language sql stable as $$ select false $$`);
  for (const m of MIGRATIONS) await c.query(localizeSql(m.startsWith("0140") ? mutate(mig(m)) : mig(m), schema));
  return schema;
}

export async function dropFixture(clients, schema) {
  if (!/^wl_cc_[0-9a-f]{12}$/.test(schema)) throw new Error("refusing to drop a schema that is not ours");
  await clients[0].query(`drop schema if exists ${schema} cascade`);
}

/** Wraps the fixture with the small helpers the checks use. `fx` is validated, so it is safe inside SQL text. */
export function makeCtx(clients, schema) {
  const fx = schema;
  let n = 0;
  const uid = () => `00000000-0000-4000-8000-${randomBytes(6).toString("hex")}`.slice(0, 36);
  const run = async (client, sql, params) => (await client.query(sql, params)).rows;
  const call = async (client, expr, params) => (await run(client, `select (${expr.split("fx.").join(`${fx}.`)}) as r`, params))[0].r;
  const outcome = (s) => (s.status === "fulfilled" ? { ok: true, value: s.value } : { ok: false, code: s.reason?.code ?? "none", message: String(s.reason?.message ?? "") });
  /** Settles an array of promises, or passes through the result of parallel(). */
  const settle = async (fns) => (typeof fns?.then === "function" ? fns : (await Promise.allSettled(fns)).map(outcome));
  /** Runs `count` operations over the connections: every connection works its own share one query at a time (no pipelining), all connections at once. */
  const parallel = async (count, make) => {
    const out = new Array(count);
    const lane = async (l) => {
      for (let i = l; i < count; i += clients.length) out[i] = outcome(await Promise.allSettled([make(clients[l], i)]).then((r) => r[0]));
    };
    await Promise.all(clients.map((_, l) => lane(l)));
    return out;
  };
  const newAccount = async () => {
    const id = uid();
    await clients[0].query(`insert into ${fx}.accounts (id) values ($1)`, [id]);
    return id;
  };
  const grant = (acc, kind, credits, exp, key) => call(clients[0], `fx.wallet_grant($1::uuid, $2, $3::bigint, $4::timestamptz, $5)`, [acc, kind, credits * 1_000_000, exp, key]);
  const key = (p) => `${p}-${++n}`;
  return { clients, fx, uid, run, call, settle, parallel, newAccount, grant, key, size: clients.length };
}

/** Everything that must hold for one account after any amount of parallel work. Returns a reason or null. */
export async function accountProblem(ctx, acc) {
  const { run, fx, clients } = ctx;
  const c = clients[0];
  const bal = (await run(c, `select balance_micro::float8 as b from ${fx}.wallet_accounts where account_id = $1`, [acc]))[0]?.b ?? 0;
  const lots = await run(c, `select remaining_units::float8 as r, reserved_units::float8 as h, granted_units::float8 as g from ${fx}.wallet_lots where account_id = $1`, [acc]);
  const held = (await run(c, `select coalesce(sum(units), 0)::float8 as u from ${fx}.wallet_holds where account_id = $1 and status = 'held'`, [acc]))[0].u;
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  if (bal < 0) return "negative balance";
  if (sum(lots.map((l) => l.r)) !== bal) return `balance ${bal} differs from the lots ${sum(lots.map((l) => l.r))}`;
  if (lots.some((l) => l.r < 0 || l.h < 0 || l.h > l.r || l.r > l.g)) return "a lot broke its limits";
  if (sum(lots.map((l) => l.h)) !== held) return "reserved units differ from the open holds";
  const rows = await run(c, `select delta_micro::float8 as d, balance_after_micro::float8 as b,
    (select coalesce(sum((e ->> 'units')::bigint), 0) from jsonb_array_elements(coalesce(lot_breakdown, '[]'::jsonb)) e)::float8 as parts
    from ${fx}.wallet_ledger where account_id = $1 order by id`, [acc]);
  return chainProblem(rows, bal);
}
