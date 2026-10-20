// PGlite harness for migration 0140 (a real Postgres engine in WASM). A LOCAL helper: the public repository has no SQL test
// service of its own, so this borrows PGlite by absolute path (override with WALLET_PGLITE). It builds Supabase like roles and a
// stand in for is_account_member(), applies 0139 once and 0140 twice, and gives the checks small helpers.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PGLITE = process.env.WALLET_PGLITE ?? "C:/Users/werne/Claude/lazyrelay-content-sources/node_modules/@electric-sql/pglite/dist/index.js";
const { PGlite } = await import(pathToFileURL(PGLITE).href);
const dir = new URL("../../supabase/migrations/", import.meta.url);
export const MIGRATION_0139 = readFileSync(new URL("0139_wallet_ledger.sql", dir), "utf8");
export const MIGRATION_0140_PATH = new URL("0140_wallet_credit_lots.sql", dir);
export const readMigration0140 = () => (existsSync(MIGRATION_0140_PATH) ? readFileSync(MIGRATION_0140_PATH, "utf8").replaceAll(String.fromCharCode(13), "") : "");

export const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const USER_A = "11111111-1111-4111-8111-111111111111";
export const MICRO = 1_000_000;

const ROLES = `
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
`;

/** A fresh database with 0139 applied once and the given 0140 text applied `times` times (twice proves it is safe to re-run). */
export async function freshDb(sql0140, times = 2) {
  const db = new PGlite();
  await db.exec(ROLES);
  await db.exec(MIGRATION_0139);
  for (let i = 0; i < times; i++) await db.exec(sql0140);
  return db;
}

/** A database where 0139 already holds data (a credit and a charge in micro dollars) before 0140 is applied. */
export async function legacyDb(sql0140) {
  const db = new PGlite();
  await db.exec(ROLES);
  await db.exec(MIGRATION_0139);
  await db.query(`select public.wallet_credit($1::uuid, 5000000, 'old-top', 'old')`, [A]);
  await db.query(`select public.wallet_charge($1::uuid, 'api_dispatch', 3, 'old-charge')`, [A]);
  await db.exec(sql0140);
  return db;
}

/** Everything that defines the wallet schema, as text, so two databases can be compared. */
export async function snapshot(db) {
  const q = async (sql) => JSON.stringify((await db.query(sql)).rows);
  return [
    await q(`select table_name, column_name, data_type, column_default, is_nullable from information_schema.columns where table_schema = 'public' and table_name like 'wallet%' order by 1, 2`),
    await q(`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as d from pg_constraint where connamespace = 'public'::regnamespace and conrelid::regclass::text like 'wallet%' order by 1, 2`),
    await q(`select tablename, policyname, cmd, qual from pg_policies where schemaname = 'public' and tablename like 'wallet%' order by 1, 2`),
    await q(`select p.proname, pg_get_function_identity_arguments(p.oid) as a, md5(pg_get_functiondef(p.oid)) as body, p.proacl::text as acl from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'wallet%' order by 1, 2`),
    await q(`select action_type, price_micro, active from public.wallet_prices order by 1`),
    await q(`select sku, name, kind, price_cents, credits, expires, \"interval\", requires_plan, grants_plan, paddle_price_id, active from public.wallet_packs order by sku`),
  ].join("|");
}

export function helpers(db) {
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const rows = async (sql, params) => (await db.query(sql, params)).rows;
  async function fails(sql, code, params, messagePart) {
    try {
      await db.query(sql, params);
    } catch (e) {
      if (e.code !== code) return `wrong code ${e.code}: ${e.message}`;
      return messagePart && !String(e.message).includes(messagePart) ? `wrong message: ${e.message}` : true;
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
  const call = async (sql, params) => (await one(`select (${sql}) as r`, params)).r;
  const newAccount = async (id) => { await db.query(`insert into public.accounts (id) values ($1)`, [id]); return id; };
  let n = 0;
  const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const grant = (acc, kind, units, exp, key) => call(`public.wallet_grant($1::uuid, $2, $3::bigint, $4::timestamptz, $5)`, [acc, kind, units, exp, key]);
  const hold = (acc, action, key) => call(`public.wallet_hold($1::uuid, $2, $3)`, [acc, action, key]);
  const commit = (id) => call(`public.wallet_commit($1::uuid)`, [id]);
  const release = (id) => call(`public.wallet_release($1::uuid)`, [id]);
  const charge = (acc, action, units, key) => call(`public.wallet_charge($1::uuid, $2, $3, $4)`, [acc, action, units, key]);
  const balance = (acc, now) => call(`public.wallet_balance($1::uuid, coalesce($2::timestamptz, now()))`, [acc, now ?? null]);
  const accountBalance = async (acc) => Number((await one(`select balance_micro from public.wallet_accounts where account_id = $1`, [acc]))?.balance_micro ?? 0);
  const lots = (acc) => rows(`select id, kind, granted_units::float8 as g, remaining_units::float8 as r, reserved_units::float8 as h, expires_at from public.wallet_lots where account_id = $1 order by granted_at, id`, [acc]);
  const ledgerCount = async (acc) => Number((await one(`select count(*) as n from public.wallet_ledger where account_id = $1`, [acc])).n);
  const future = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
  return { one, rows, fails, asRole, deniedAs, call, newAccount, uid, grant, hold, commit, release, charge, balance, accountBalance, lots, ledgerCount, future };
}
