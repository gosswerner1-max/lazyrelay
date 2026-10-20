// Checks of the spend logic: overdraft, bucket order, expiry, holds, idempotency. Each check returns true or a reason.
import { MICRO } from "./harness.mjs";

export const M = (credits) => credits * MICRO;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

export function spendChecks({ db, h }) {
  const fresh = async () => h.newAccount(h.uid());
  const age = (id) => db.query(`update public.wallet_lots set granted_at = now() - interval '2 days', expires_at = now() - interval '1 minute' where id = $1`, [id]);
  const checks = [];
  const t = (name, fn) => checks.push({ name, fn });

  t("prices are seeded in micro credits: post_publish 1 credit, competitor_teardown 10 credits, no youtube row, old actions inactive", async () => {
    const r = await h.rows(`select action_type, price_micro::float8 as p, active from public.wallet_prices order by 1`);
    const want = [["api_dispatch", false], ["competitor_teardown", true], ["post_publish", true], ["sitemap_sync", false]];
    return JSON.stringify(r.map((x) => [x.action_type, x.active])) === JSON.stringify(want) && r.find((x) => x.action_type === "post_publish").p === M(1) && r.find((x) => x.action_type === "competitor_teardown").p === M(10);
  });
  t("zero overdraft: a charge above the spendable total is refused with insufficient_credits and changes nothing", async () => {
    const acc = await fresh();
    await h.grant(acc, "pack", M(5), null, "g1");
    const n = await h.ledgerCount(acc);
    const r = await h.charge(acc, "post_publish", 6, "c1");
    return r.ok === false && r.reason === "insufficient_credits" && r.required_micro === M(6) && (await h.ledgerCount(acc)) === n && (await h.accountBalance(acc)) === M(5);
  });
  t("check constraints refuse a negative remaining, a negative reserved, reserved above remaining and a negative balance", async () => {
    const acc = await fresh();
    await h.grant(acc, "pack", M(5), null, "g1");
    return (
      (await h.fails(`update public.wallet_lots set remaining_units = -1 where account_id = $1`, "23514", [acc])) === true &&
      (await h.fails(`update public.wallet_lots set reserved_units = -1 where account_id = $1`, "23514", [acc])) === true &&
      (await h.fails(`update public.wallet_lots set reserved_units = remaining_units + 1 where account_id = $1`, "23514", [acc])) === true &&
      (await h.fails(`update public.wallet_accounts set balance_micro = -1 where account_id = $1`, "23514", [acc])) === true
    );
  });
  t("bucket order: expiring lots first (earliest expiry first), then the oldest non-expiring lot, across several lots with an exact breakdown", async () => {
    const acc = await fresh();
    const signup = (await h.grant(acc, "signup", M(20), null, "s")).lot_id;
    const pack = (await h.grant(acc, "pack", M(100), null, "p")).lot_id;
    const later = (await h.grant(acc, "subscription", M(50), h.future(10), "x")).lot_id;
    const sooner = (await h.grant(acc, "subscription", M(30), h.future(5), "y")).lot_id;
    const r = await h.charge(acc, "post_publish", 90, "spend");
    const e = await h.one(`select lot_breakdown, delta_micro::float8 as d, balance_after_micro::float8 as b from public.wallet_ledger where account_id = $1 and kind = 'charge'`, [acc]);
    const got = JSON.stringify(e.lot_breakdown.map((x) => [x.lot_id, x.units]));
    const want = JSON.stringify([[sooner, M(30)], [later, M(50)], [signup, M(10)]]);
    const lots = Object.fromEntries((await h.lots(acc)).map((l) => [l.id, l.r]));
    return r.ok && got === want && e.d === -M(90) && e.b === M(110) && lots[sooner] === 0 && lots[later] === 0 && lots[signup] === M(10) && lots[pack] === M(100);
  });
  t("bucket order: with only non-expiring lots the oldest is spent first", async () => {
    const acc = await fresh();
    const first = (await h.grant(acc, "pack", M(10), null, "p1")).lot_id;
    const second = (await h.grant(acc, "pack", M(10), null, "p2")).lot_id;
    await h.charge(acc, "post_publish", 4, "c");
    const l = Object.fromEntries((await h.lots(acc)).map((x) => [x.id, x.r]));
    return l[first] === M(6) && l[second] === M(10);
  });
  t("a subscription lot is never spent after its expires_at (spend and pick both refuse it)", async () => {
    const acc = await fresh();
    const sub = (await h.grant(acc, "subscription", M(50), h.future(1), "s")).lot_id;
    await h.grant(acc, "pack", M(5), null, "p");
    const open = await h.rows(`select * from public.wallet_pick_lots($1, $2, now() + interval '20 days')`, [acc, M(10)]);
    const inTime = await h.rows(`select * from public.wallet_pick_lots($1, $2, now())`, [acc, M(10)]);
    await age(sub);
    const over = await h.charge(acc, "post_publish", 10, "over");
    const ok = await h.charge(acc, "post_publish", 5, "ok");
    return open.length === 0 && inTime.length === 1 && inTime[0].lot_id === sub && over.ok === false && ok.ok === true;
  });
  t("a hold reserves credits without debiting: no ledger row, balance unchanged, spendable lower", async () => {
    const acc = await fresh();
    await h.grant(acc, "pack", M(20), null, "g");
    const n = await h.ledgerCount(acc);
    const r = await h.hold(acc, "competitor_teardown", "h1");
    const b = await h.balance(acc);
    const l = (await h.lots(acc))[0];
    return r.ok && r.held_micro === M(10) && b.spendable_micro === M(10) && b.held_micro === M(10) && (await h.accountBalance(acc)) === M(20) && (await h.ledgerCount(acc)) === n && l.r === M(20) && l.h === M(10);
  });
  t("commit debits exactly the held breakdown and writes one hold_commit entry carrying it", async () => {
    const acc = await fresh();
    const sub = (await h.grant(acc, "subscription", M(4), h.future(3), "s")).lot_id;
    const pack = (await h.grant(acc, "pack", M(20), null, "p")).lot_id;
    const hd = await h.hold(acc, "competitor_teardown", "h1");
    const held = (await h.one(`select breakdown from public.wallet_holds where id = $1`, [hd.hold_id])).breakdown;
    const c = await h.commit(hd.hold_id);
    const e = await h.one(`select kind, delta_micro::float8 as d, balance_after_micro::float8 as b, lot_breakdown, action_type from public.wallet_ledger where account_id = $1 and kind = 'hold_commit'`, [acc]);
    const l = Object.fromEntries((await h.lots(acc)).map((x) => [x.id, x]));
    return c.ok && JSON.stringify(held.map((x) => [x.lot_id, x.units])) === JSON.stringify([[sub, M(4)], [pack, M(6)]]) && JSON.stringify(e.lot_breakdown) === JSON.stringify(held) &&
      e.d === -M(10) && e.b === M(14) && e.action_type === "competitor_teardown" && l[sub].r === 0 && l[pack].r === M(14) && l[pack].h === 0 && (await h.accountBalance(acc)) === M(14);
  });
  t("committing twice is a replay and debits once; a released hold cannot be committed", async () => {
    const acc = await fresh();
    await h.grant(acc, "pack", M(30), null, "g");
    const a = await h.hold(acc, "competitor_teardown", "h1");
    await h.commit(a.hold_id);
    const again = await h.commit(a.hold_id);
    const b = await h.hold(acc, "competitor_teardown", "h2");
    await h.release(b.hold_id);
    const late = await h.commit(b.hold_id);
    return again.replay === true && (await h.accountBalance(acc)) === M(20) && late.ok === false && late.reason === "hold_not_held";
  });
  t("release frees the reservation: lots unchanged, no ledger row, replay is harmless", async () => {
    const acc = await fresh();
    await h.grant(acc, "pack", M(20), null, "g");
    const hd = await h.hold(acc, "competitor_teardown", "h1");
    const n = await h.ledgerCount(acc);
    const r = await h.release(hd.hold_id);
    const again = await h.release(hd.hold_id);
    const l = (await h.lots(acc))[0];
    const st = (await h.one(`select status from public.wallet_holds where id = $1`, [hd.hold_id])).status;
    return r.ok && again.ok && again.replay === true && l.h === 0 && l.r === M(20) && (await h.ledgerCount(acc)) === n && st === "released" && (await h.balance(acc)).spendable_micro === M(20);
  });
  t("hold expiry frees the reservation only after the 15 minutes, and an expired hold cannot be committed", async () => {
    const acc = await fresh();
    await h.grant(acc, "pack", M(20), null, "g");
    const hd = await h.hold(acc, "competitor_teardown", "h1");
    await h.call(`public.wallet_expire_holds(now() + interval '10 minutes')`);
    const early = (await h.lots(acc))[0].h;
    await h.call(`public.wallet_expire_holds(now() + interval '16 minutes')`);
    const st = (await h.one(`select status from public.wallet_holds where id = $1`, [hd.hold_id])).status;
    const late = await h.commit(hd.hold_id);
    return early === M(10) && (await h.lots(acc))[0].h === 0 && st === "expired" && late.ok === false;
  });
  t("an idempotent replay of hold, charge and grant returns the first answer and changes nothing", async () => {
    const acc = await fresh();
    const g1 = await h.grant(acc, "pack", M(50), null, "g");
    const g2 = await h.grant(acc, "pack", M(50), null, "g");
    const h1 = await h.hold(acc, "competitor_teardown", "h");
    const h2 = await h.hold(acc, "competitor_teardown", "h");
    const c1 = await h.charge(acc, "post_publish", 3, "c");
    const c2 = await h.charge(acc, "post_publish", 3, "c");
    const lots = await h.lots(acc);
    return g2.replay === true && g1.lot_id === g2.lot_id && h2.replay === true && h1.hold_id === h2.hold_id && c2.replay === true && c2.charged_micro === c1.charged_micro &&
      lots.length === 1 && lots[0].h === M(10) && lots[0].r === M(47) && (await h.ledgerCount(acc)) === 2;
  });
  t("the same key with a different action, units or grant is refused with idempotency_conflict", async () => {
    const acc = await fresh();
    await h.grant(acc, "pack", M(50), null, "g");
    await h.hold(acc, "competitor_teardown", "h");
    await h.charge(acc, "post_publish", 3, "c");
    const e = (sql) => h.fails(sql, "23505", [acc], "idempotency_conflict");
    return (
      (await e(`select public.wallet_hold($1::uuid, 'post_publish', 'h')`)) === true &&
      (await e(`select public.wallet_charge($1::uuid, 'post_publish', 4, 'c')`)) === true &&
      (await e(`select public.wallet_charge($1::uuid, 'competitor_teardown', 3, 'c')`)) === true &&
      (await e(`select public.wallet_grant($1::uuid, 'pack', 51000000, null, 'g')`)) === true &&
      (await e(`select public.wallet_grant($1::uuid, 'subscription', 50000000, now() + interval '3 days', 'g')`)) === true
    );
  });
  t("two sequential holds cannot together exceed the balance", async () => {
    const acc = await fresh();
    await h.grant(acc, "pack", M(15), null, "g");
    const a = await h.hold(acc, "competitor_teardown", "a");
    const b = await h.hold(acc, "competitor_teardown", "b");
    const c = await h.hold(acc, "post_publish", "c");
    return a.ok && b.ok === false && b.reason === "insufficient_credits" && c.ok && (await h.balance(acc)).spendable_micro === M(4);
  });
  t("edges: exactly 10 credits allow one teardown and 9 refuse; 1 credit allows one post and then refuses", async () => {
    const ten = await fresh();
    const nine = await fresh();
    const one = await fresh();
    await h.grant(ten, "pack", M(10), null, "g");
    await h.grant(nine, "pack", M(9), null, "g");
    await h.grant(one, "pack", M(1), null, "g");
    const a = await h.hold(ten, "competitor_teardown", "h");
    const a2 = await h.hold(ten, "competitor_teardown", "h2");
    const b = await h.hold(nine, "competitor_teardown", "h");
    const c1 = await h.charge(one, "post_publish", 1, "p1");
    const c2 = await h.charge(one, "post_publish", 1, "p2");
    return a.ok && a2.ok === false && b.ok === false && b.required_micro === M(10) && c1.ok && c1.balance_micro === 0 && c2.ok === false;
  });
  t("an unknown, retired or youtube action, a bad unit count and a bad grant are refused (22023)", async () => {
    const acc = await fresh();
    const bad = (sql) => h.fails(sql, "22023", [acc]);
    const results = [];
    for (const sql of [
      `select public.wallet_charge($1::uuid, 'api_dispatch', 1, 'k1')`, `select public.wallet_charge($1::uuid, 'sitemap_sync', 1, 'k2')`,
      `select public.wallet_hold($1::uuid, 'youtube_teardown', 'k3')`, `select public.wallet_charge($1::uuid, 'post_publish', 0, 'k4')`,
      `select public.wallet_charge($1::uuid, 'post_publish', -2, 'k5')`, `select public.wallet_grant($1::uuid, 'pack', 0, null, 'k6')`,
      `select public.wallet_grant($1::uuid, 'pack', -5, null, 'k7')`, `select public.wallet_grant($1::uuid, 'subscription', 1000000, null, 'k8')`,
      `select public.wallet_grant($1::uuid, 'pack', 1000000, now() + interval '1 day', 'k9')`, `select public.wallet_grant($1::uuid, 'gift', 1000000, null, 'k10')`,
      `select public.wallet_credit($1::uuid, 1000, 'k11')`,
    ]) results.push(await bad(sql));
    return results.every((x) => x === true) || results.join("|");
  });
  t("signup grant once only: the same source_key replays, a second signup under another key is refused", async () => {
    const acc = await fresh();
    const a = await h.grant(acc, "signup", M(30), null, `signup:${acc}`);
    const b = await h.grant(acc, "signup", M(30), null, `signup:${acc}`);
    const c = await h.fails(`select public.wallet_grant($1::uuid, 'signup', 30000000, null, 'another')`, "23505", [acc]);
    return a.ok && b.replay === true && c === true && (await h.lots(acc)).length === 1 && (await h.accountBalance(acc)) === M(30);
  });
  t("wallet_expire writes one expire entry per lot for the expired amount and never touches non-expiring lots; a second run does nothing", async () => {
    const acc = await fresh();
    const s1 = (await h.grant(acc, "subscription", M(40), h.future(5), "s1")).lot_id;
    const s2 = (await h.grant(acc, "subscription", M(25), h.future(9), "s2")).lot_id;
    const pack = (await h.grant(acc, "pack", M(7), null, "p")).lot_id;
    await h.charge(acc, "post_publish", 10, "use");
    const r = await h.call(`public.wallet_expire(now() + interval '6 days')`);
    const again = await h.call(`public.wallet_expire(now() + interval '6 days')`);
    const e = await h.rows(`select delta_micro::float8 as d, balance_after_micro::float8 as b, lot_breakdown from public.wallet_ledger where account_id = $1 and kind = 'expire'`, [acc]);
    const l = Object.fromEntries((await h.lots(acc)).map((x) => [x.id, x.r]));
    return e.length === 1 && e[0].d === -M(30) && e[0].lot_breakdown[0].lot_id === s1 && l[s1] === 0 && l[s2] === M(25) && l[pack] === M(7) && r.expired_lots >= 1 && again.expired_lots === 0 && (await h.accountBalance(acc)) === M(32);
  });
  t("a hold placed before its lot expired is honoured on commit, and only the unreserved part expires", async () => {
    const acc = await fresh();
    const sub = (await h.grant(acc, "subscription", M(12), h.future(1), "s")).lot_id;
    const hd = await h.hold(acc, "competitor_teardown", "h");
    await age(sub);
    await h.call(`public.wallet_expire(now())`);
    const mid = (await h.lots(acc))[0];
    const c = await h.commit(hd.hold_id);
    return mid.r === M(10) && mid.h === M(10) && c.ok === true && (await h.accountBalance(acc)) === 0;
  });
  t("wallet_balance reports spendable, held and the next expiry (date and amount)", async () => {
    const acc = await fresh();
    const soon = h.future(4);
    await h.grant(acc, "subscription", M(40), soon, "s");
    await h.grant(acc, "subscription", M(60), h.future(20), "s2");
    await h.grant(acc, "pack", M(15), null, "p");
    await h.hold(acc, "competitor_teardown", "h");
    const b = await h.balance(acc);
    return b.spendable_micro === M(105) && b.held_micro === M(10) && new Date(b.next_expiry_at).toISOString() === soon && b.next_expiry_micro === M(30);
  });
  t("wallet_paused_account_ids lists a wallet whose spendable credits are below the cheapest action, and not one that can pay", async () => {
    const poor = await fresh();
    const rich = await fresh();
    await h.grant(poor, "pack", 500_000, null, "g");
    await h.grant(rich, "pack", M(5), null, "g");
    const ids = (await h.rows(`select * from public.wallet_paused_account_ids(1000000) as id`)).map((r) => r.id);
    return ids.includes(poor) && !ids.includes(rich);
  });
  return checks;
}

export async function invariants(h, acc) {
  const bal = await h.accountBalance(acc);
  const lots = await h.lots(acc);
  const holds = await h.rows(`select units::float8 as u, status from public.wallet_holds where account_id = $1`, [acc]);
  if (bal < 0 || bal !== sum(lots.map((l) => l.r))) return `balance ${bal} differs from lots ${sum(lots.map((l) => l.r))}`;
  if (sum(lots.map((l) => l.h)) !== sum(holds.filter((x) => x.status === "held").map((x) => x.u))) return "reserved does not match open holds";
  if (lots.some((l) => l.r < 0 || l.h < 0 || l.h > l.r)) return "a lot broke its limits";
  let run = 0;
  for (const r of await h.rows(`select delta_micro::float8 as d, balance_after_micro::float8 as b, lot_breakdown from public.wallet_ledger where account_id = $1 order by id`, [acc])) {
    run += r.d;
    if (run !== r.b || run < 0) return `chain broke at ${run} vs ${r.b}`;
    const parts = sum((r.lot_breakdown ?? []).map((x) => x.units));
    if (parts !== Math.abs(r.d)) return `breakdown ${parts} differs from delta ${r.d}`;
  }
  return run === bal ? true : `chain end ${run} differs from balance ${bal}`;
}

async function randomStep({ db, h }, acc, rnd, open, i) {
  const p = rnd();
  const credits = 1 + Math.floor(rnd() * 40);
  if (p < 0.2) {
    if (rnd() < 0.5) await h.grant(acc, "pack", M(credits), null, `g${i}`);
    else await h.grant(acc, "subscription", M(credits), h.future(1 + Math.floor(rnd() * 30)), `g${i}`);
  } else if (p < 0.4) {
    const r = await h.hold(acc, rnd() < 0.6 ? "competitor_teardown" : "post_publish", `h${i}`);
    if (r.ok) open.push(r.hold_id);
  } else if (p < 0.55 && open.length) await h.commit(open.splice(Math.floor(rnd() * open.length), 1)[0]);
  else if (p < 0.65 && open.length) await h.release(open.splice(Math.floor(rnd() * open.length), 1)[0]);
  else if (p < 0.85) await h.charge(acc, "post_publish", 1 + Math.floor(rnd() * 12), `c${i}`);
  else if (p < 0.92) {
    const l = await h.rows(`select id from public.wallet_lots where account_id = $1 and expires_at is not null and expires_at > now() and remaining_units > reserved_units limit 1`, [acc]);
    if (l[0]) await db.query(`update public.wallet_lots set granted_at = now() - interval '2 days', expires_at = now() - interval '1 minute' where id = $1`, [l[0].id]);
    await h.call(`public.wallet_expire(now())`);
  } else await h.call(`public.wallet_expire_holds(now() + interval '20 minutes')`);
}

export function randomCheck(ctx, ops) {
  return {
    name: `${ops} random operations: no overdraft, lots add up to the balance, holds add up to reserved, the ledger chain and breakdowns stay exact`,
    fn: async () => {
      const acc = await ctx.h.newAccount(ctx.h.uid());
      let seed = 4242;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const open = [];
      for (let i = 0; i < ops; i++) {
        await randomStep(ctx, acc, rnd, open, i);
        if (i % 100 === 99) {
          const bad = await invariants(ctx.h, acc);
          if (bad !== true) return `op ${i}: ${bad}`;
        }
      }
      return invariants(ctx.h, acc);
    },
  };
}
