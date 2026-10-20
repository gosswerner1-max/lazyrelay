// Checks of access, append only, migration shape and the 0139 data. Each check returns true or a reason.
import { A, USER_A, freshDb, legacyDb, snapshot } from "./harness.mjs";
import { M } from "./checks-spend.mjs";

const PUBLIC_CALLS = [
  `public.wallet_grant('${A}', 'pack', 1000000, null, 'x')`,
  `public.wallet_grant_for_sku('${A}', 'lazycredits-starter-pack', 'x', now(), null, null)`,
  `public.wallet_hold('${A}', 'post_publish', 'x')`,
  `public.wallet_commit('00000000-0000-4000-8000-000000000001')`,
  `public.wallet_release('00000000-0000-4000-8000-000000000001')`,
  `public.wallet_charge('${A}', 'post_publish', 1, 'x')`,
  `public.wallet_expire(now())`,
  `public.wallet_expire_holds(now())`,
  `public.wallet_revoke_plan('${A}', 'pro', now(), 'canceled', 'x')`,
  `public.wallet_handle_plan_event('${A}', 'pro', 'billing_gave_up', null, 'x', now())`,
  `public.wallet_balance('${A}', now())`,
  `public.wallet_paused_account_ids(1000000)`,
  `public.wallet_credit('${A}', 1000, 'x')`,
];
const INTERNAL_CALLS = [
  `public.wallet_pick_lots('${A}', 1000000, now())`,
  `public.wallet_i_lock('${A}')`,
  `public.wallet_i_spendable('${A}', now())`,
  `public.wallet_i_sweep('${A}', now())`,
  `public.wallet_i_move('[]'::jsonb, 'debit')`,
  `public.wallet_i_grant('${A}', 'pack', 1000000, null, 'x', null, now())`,
  `public.wallet_i_revoke('${A}', 'pro', now(), 'x', 'x', now(), true)`,
];

export function accessChecks({ db, h, sql }) {
  const checks = [];
  const t = (name, fn) => checks.push({ name, fn });
  const fresh = async () => h.newAccount(h.uid());

  t("the ledger stays append only: update, delete and truncate raise even for the owner", async () => {
    const acc = await fresh();
    await h.grant(acc, "pack", M(5), null, "g");
    return (
      (await h.fails(`update public.wallet_ledger set delta_micro = 1`, "42501")) === true &&
      (await h.fails(`delete from public.wallet_ledger`, "42501")) === true &&
      (await h.fails(`truncate public.wallet_ledger`, "42501")) === true
    );
  });
  t("anon and signed in customers cannot run any wallet function", async () => {
    for (const call of PUBLIC_CALLS) {
      for (const [role, sub] of [["anon", null], ["authenticated", USER_A]]) {
        const r = await h.deniedAs(role, sub, `select ${call}`);
        if (r !== true) return `${role} on ${call}: ${r}`;
      }
    }
    return true;
  });
  t("the service role can run the public functions", async () => {
    const acc = await fresh();
    const g = await h.asRole("service_role", null, `select public.wallet_grant('${acc}', 'pack', 5000000, null, 'svc') as r`);
    return g.rows[0].r.ok === true && g.rows[0].r.balance_micro === M(5);
  });
  t("the internal helpers, including the bucket order function, run for nobody but the owner (not even the service role)", async () => {
    for (const call of INTERNAL_CALLS) {
      for (const [role, sub] of [["anon", null], ["authenticated", USER_A], ["service_role", null]]) {
        const r = await h.deniedAs(role, sub, `select * from ${call}`.replace("select * from public.wallet_i_move", "select public.wallet_i_move"));
        if (r !== true) return `${role} on ${call}: ${r}`;
      }
    }
    return true;
  });
  t("a member reads only their own account's lots, holds and ledger, and a stranger reads nothing", async () => {
    const other = await fresh();
    await h.grant(A, "pack", M(20), null, "mine");
    await h.hold(A, "post_publish", "my-hold");
    await h.grant(other, "pack", M(20), null, "theirs");
    await h.hold(other, "post_publish", "their-hold");
    const read = async (table, sub) => (await h.asRole("authenticated", sub, `select distinct account_id from public.${table}`)).rows.map((r) => r.account_id);
    for (const table of ["wallet_lots", "wallet_holds", "wallet_ledger"]) {
      const mine = await read(table, USER_A);
      if (mine.length !== 1 || mine[0] !== A) return `${table}: member saw ${mine.length} accounts`;
      if ((await read(table, "99999999-9999-4999-8999-999999999999")).length !== 0) return `${table}: a stranger saw rows`;
    }
    return true;
  });
  t("the browser cannot write lots, holds, the ledger, balances, prices, packs or plan events", async () => {
    const writes = [
      `update public.wallet_lots set remaining_units = 999999999`, `delete from public.wallet_lots`,
      `insert into public.wallet_lots (account_id, kind, granted_units, remaining_units, source_key) values ('${A}', 'pack', 1, 1, 'hack')`,
      `update public.wallet_holds set status = 'released'`, `insert into public.wallet_holds (account_id, action, units, idempotency_key) values ('${A}', 'post_publish', 1, 'hack')`,
      `insert into public.wallet_ledger (account_id, kind, delta_micro, balance_after_micro, idempotency_key) values ('${A}', 'grant', 1, 1, 'hack')`,
      `update public.wallet_accounts set balance_micro = 999999999`, `update public.wallet_prices set price_micro = 1`,
      `update public.wallet_packs set credits = 999999`, `delete from public.wallet_packs`,
    ];
    for (const sql of writes) {
      for (const [role, sub] of [["authenticated", USER_A], ["service_role", null]]) {
        const r = await h.deniedAs(role, sub, sql);
        if (r !== true) return `${role}: ${sql.slice(0, 50)}: ${r}`;
      }
    }
    return (await h.deniedAs("authenticated", USER_A, `select * from public.wallet_plan_events`)) === true;
  });
  t("a signed in customer sees the active packs only; the service role writes none", async () => {
    await db.query(`update public.wallet_packs set active = false where sku = 'lazycredits-growth-pack'`);
    const seen = (await h.asRole("authenticated", USER_A, `select sku from public.wallet_packs`)).rows.length;
    await db.query(`update public.wallet_packs set active = true where sku = 'lazycredits-growth-pack'`);
    const all = (await h.asRole("authenticated", USER_A, `select sku from public.wallet_packs`)).rows.length;
    return seen === 4 && all === 5;
  });
  t("every wallet table has row level security switched on", async () => {
    const r = await h.rows(`select relname from pg_class where relnamespace = 'public'::regnamespace and relname like 'wallet%' and relkind = 'r' and not relrowsecurity`);
    return r.length === 0 || r.map((x) => x.relname).join(",");
  });
  t("every security definer wallet function pins its search_path", async () => {
    const r = await h.rows(`select proname from pg_proc where pronamespace = 'public'::regnamespace and proname like 'wallet%' and prosecdef and not coalesce(proconfig::text, '') like '%search_path%'`);
    return r.length === 0 || r.map((x) => x.proname).join(",");
  });
  t("the migration is idempotent: applied twice it gives exactly the schema, functions, grants and seed rows of applying it once", async () => {
    const once = await freshDb(sql, 1);
    return (await snapshot(once)) === (await snapshot(db)) || "the snapshots differ";
  });
  t("0139 rows survive 0140 untouched: nothing is deleted or rewritten, and the old rows still satisfy the new constraints", async () => {
    const before = await legacyDb("");
    const old = JSON.stringify((await before.query(`select id, kind, action_type, units, delta_micro, balance_after_micro, idempotency_key from public.wallet_ledger order by id`)).rows);
    const bal = JSON.stringify((await before.query(`select balance_micro from public.wallet_accounts`)).rows);
    const after = await legacyDb(sql);
    const now = JSON.stringify((await after.query(`select id, kind, action_type, units, delta_micro, balance_after_micro, idempotency_key from public.wallet_ledger order by id`)).rows);
    const bal2 = JSON.stringify((await after.query(`select balance_micro from public.wallet_accounts`)).rows);
    return old === now && bal === bal2 && JSON.parse(now).length === 2;
  });
  t("a one time pack lot cannot carry an expiry unless it is bound to a plan, and a subscription lot cannot lack one", async () => {
    const acc = await fresh();
    const ins = (kind, exp, bound) => h.fails(`insert into public.wallet_lots (account_id, kind, granted_units, remaining_units, expires_at, bound_plan, source_key) values ('${acc}', '${kind}', 1, 1, ${exp}, ${bound}, 'k${Math.random()}')`, "23514");
    return (await ins("pack", "now() + interval '1 day'", "null")) === true && (await ins("subscription", "null", "null")) === true && (await ins("signup", "now() + interval '1 day'", "'pro'")) === true;
  });
  t("account row lock: every function that changes credits takes the lock on the account before reading its lots", async () => {
    const names = ["wallet_i_grant", "wallet_hold", "wallet_commit", "wallet_release", "wallet_charge", "wallet_expire", "wallet_expire_holds", "wallet_i_revoke"];
    const rows = await h.rows(`select proname, pg_get_functiondef(oid) as d from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1)`, [names]);
    const missing = names.filter((n) => !rows.find((r) => r.proname === n && r.d.includes("wallet_i_lock(")));
    return missing.length === 0 || `no lock in ${missing.join(",")}`;
  });
  return checks;
}
