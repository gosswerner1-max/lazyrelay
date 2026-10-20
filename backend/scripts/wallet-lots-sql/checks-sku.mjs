// Checks of the pack catalog, the SKU gate, renewal, plan revoke and the lapse policy. Each check returns true or a reason.
import { M, invariants } from "./checks-spend.mjs";

export const SKUS = [
  ["lazycredits-starter-pack", "LazyCredits Starter Pack", "pack", 1500, 300, false, "one_time", null, null],
  ["lazycredits-growth-pack", "LazyCredits Growth Pack", "pack", 5000, 1500, false, "one_time", null, null],
  ["lazycredits-pro-top-up", "LazyCredits Pro Top-Up", "pack", 3000, 1500, false, "one_time", "pro", null],
  ["lazyrelay-growth-plan", "LazyRelay Growth Plan", "subscription", 2900, 1000, true, "month", null, "growth"],
  ["lazyrelay-pro-plan", "LazyRelay Pro Plan", "subscription", 9900, 6000, true, "month", null, "pro"],
];

export function skuChecks({ db, h }) {
  const checks = [];
  const t = (name, fn) => checks.push({ name, fn });
  const fresh = async () => h.newAccount(h.uid());
  const sku = (acc, s, key, plan, end) => h.call(`public.wallet_grant_for_sku($1::uuid, $2, $3, $4::timestamptz, $5, $6::timestamptz)`, [acc, s, key, new Date().toISOString(), plan ?? null, end ?? null]);
  const event = (acc, plan, ev, end, key) => h.call(`public.wallet_handle_plan_event($1::uuid, $2, $3, $4::timestamptz, $5, now())`, [acc, plan, ev, end ?? null, key]);
  const revoke = (acc, plan, at, reason, key) => h.call(`public.wallet_revoke_plan($1::uuid, $2, $3::timestamptz, $4, $5)`, [acc, plan, at, reason, key]);
  const expireAt = (iso) => h.call(`public.wallet_expire($1::timestamptz)`, [iso]);
  const lotMap = async (acc) => Object.fromEntries((await h.lots(acc)).map((l) => [l.id, l]));
  // The mock customer: Growth plan lot, Pro plan lot (6,000), Starter pack (300, not bound), Pro Top-Up (1,500, bound to pro).
  const rig = async (proEnd = h.future(20)) => {
    const acc = await fresh();
    const ids = {
      growth: (await sku(acc, "lazyrelay-growth-plan", "growth-1", null, h.future(25))).lot_id,
      pro: (await sku(acc, "lazyrelay-pro-plan", "pro-1", null, proEnd)).lot_id,
      starter: (await sku(acc, "lazycredits-starter-pack", "starter-1", null)).lot_id,
      topup: (await sku(acc, "lazycredits-pro-top-up", "topup-1", "pro")).lot_id,
    };
    return { acc, ids };
  };
  const expireEntries = async (acc) => h.rows(`select delta_micro::float8 as d, lot_breakdown -> 0 ->> 'lot_id' as lot from public.wallet_ledger where account_id = $1 and kind = 'expire' order by id`, [acc]);

  t("the catalog holds exactly the five SKUs with their prices, credits, expiry flags, intervals and plan gate; the Paddle price id is empty", async () => {
    const r = await h.rows(`select sku, name, kind, price_cents, credits, expires, "interval", requires_plan, grants_plan, paddle_price_id, active from public.wallet_packs order by sku`);
    const want = SKUS.map(([s, n, k, p, c, e, i, rq, g]) => ({ sku: s, name: n, kind: k, price_cents: p, credits: c, expires: e, interval: i, requires_plan: rq, grants_plan: g, paddle_price_id: null, active: true })).sort((a, b) => a.sku.localeCompare(b.sku));
    return JSON.stringify(r) === JSON.stringify(want);
  });
  t("each SKU grants exactly credits x 1,000,000 micro credits as the right lot kind: packs never expire, subscriptions expire at the given period end", async () => {
    for (const [s, , kind, , credits, , , requires] of SKUS) {
      const acc = await fresh();
      const end = kind === "subscription" ? h.future(30) : null;
      const r = await sku(acc, s, "k1", requires, end);
      const lot = (await h.lots(acc))[0];
      const okExpiry = kind === "pack" ? lot.expires_at === null : new Date(lot.expires_at).toISOString() === end;
      if (!r.ok || lot.g !== credits * 1_000_000 || lot.kind !== kind || !okExpiry || (await h.accountBalance(acc)) !== credits * 1_000_000) return `${s}: wrong grant`;
    }
    return true;
  });
  t("the amount never comes from the caller: wallet_grant_for_sku has no amount, units or credits parameter", async () => {
    const r = await h.one(`select pg_get_function_identity_arguments(oid) as a from pg_proc where proname = 'wallet_grant_for_sku'`);
    return !/units|amount|credits|micro|price/i.test(r.a) || r.a;
  });
  t("the Pro Top-Up gate: refused with plan_required unless the supplied active plan is pro; a refusal creates no lot", async () => {
    const acc = await fresh();
    const none = await sku(acc, "lazycredits-pro-top-up", "t1", null);
    const wrong = await sku(acc, "lazycredits-pro-top-up", "t2", "growth");
    const upper = await sku(acc, "lazycredits-pro-top-up", "t3", "PRO");
    const refused = (await h.lots(acc)).length;
    const ok = await sku(acc, "lazycredits-pro-top-up", "t4", "pro");
    return none.reason === "plan_required" && wrong.reason === "plan_required" && upper.reason === "plan_required" && refused === 0 && ok.ok === true && (await h.lots(acc)).length === 1;
  });
  t("an unknown or inactive SKU is refused (22023); the other packs need no plan", async () => {
    const acc = await fresh();
    await db.query(`update public.wallet_packs set active = false where sku = 'lazycredits-growth-pack'`);
    const a = await h.fails(`select public.wallet_grant_for_sku($1::uuid, 'nope', 'k', now(), null, null)`, "22023", [acc]);
    const b = await h.fails(`select public.wallet_grant_for_sku($1::uuid, 'lazycredits-growth-pack', 'k', now(), null, null)`, "22023", [acc]);
    await db.query(`update public.wallet_packs set active = true where sku = 'lazycredits-growth-pack'`);
    return a === true && b === true && (await sku(acc, "lazycredits-growth-pack", "k", null)).ok === true;
  });
  t("a subscription SKU needs a future period end", async () => {
    const acc = await fresh();
    const none = await h.fails(`select public.wallet_grant_for_sku($1::uuid, 'lazyrelay-growth-plan', 'k1', now(), null, null)`, "22023", [acc]);
    const past = await h.fails(`select public.wallet_grant_for_sku($1::uuid, 'lazyrelay-growth-plan', 'k2', now(), null, now() - interval '1 day')`, "22023", [acc]);
    return none === true && past === true;
  });
  t("replaying the same source_key grants once, even when the plan is no longer active", async () => {
    const acc = await fresh();
    const first = await sku(acc, "lazycredits-pro-top-up", "pay-1", "pro");
    const again = await sku(acc, "lazycredits-pro-top-up", "pay-1", null);
    return first.ok && again.replay === true && again.lot_id === first.lot_id && (await h.lots(acc)).length === 1 && (await h.accountBalance(acc)) === M(1500);
  });
  t("Growth lot (1,000, expiring) + Starter pack (300) + Pro lot (6,000, later expiry): spending 1,200 drains Growth then Pro; the next 5,900 drains Pro then the pack", async () => {
    const acc = await fresh();
    const g = (await sku(acc, "lazyrelay-growth-plan", "g", null, h.future(10))).lot_id;
    const s = (await sku(acc, "lazycredits-starter-pack", "s", null)).lot_id;
    const p = (await sku(acc, "lazyrelay-pro-plan", "p", null, h.future(20))).lot_id;
    await h.charge(acc, "post_publish", 1200, "c1");
    const mid = await lotMap(acc);
    const r2 = await h.charge(acc, "post_publish", 5900, "c2");
    const end = await lotMap(acc);
    return mid[g].r === 0 && mid[p].r === M(5800) && mid[s].r === M(300) && r2.ok && end[p].r === 0 && end[s].r === M(200) && (await h.accountBalance(acc)) === M(200);
  });
  t("renewal: the next period is a NEW lot with a new expiry; the old unspent credits expire through wallet_expire (no rollover)", async () => {
    const acc = await fresh();
    const end1 = h.future(30);
    const end2 = h.future(60);
    const first = (await sku(acc, "lazyrelay-growth-plan", "growth:period-1", null, end1)).lot_id;
    await h.charge(acc, "post_publish", 100, "use");
    const second = (await sku(acc, "lazyrelay-growth-plan", "growth:period-2", null, end2)).lot_id;
    const dup = await sku(acc, "lazyrelay-growth-plan", "growth:period-2", null, end2);
    await expireAt(new Date(Date.parse(end1) + 1000).toISOString());
    const l = await lotMap(acc);
    const e = await expireEntries(acc);
    return first !== second && dup.replay === true && l[first].r === 0 && l[second].r === M(1000) && new Date(l[second].expires_at).toISOString() === end2 && e.length === 1 && e[0].d === -M(900) && (await h.accountBalance(acc)) === M(1000);
  });

  t("cancel now (lapse_at = now): the Pro Top-Up and the Pro plan lots expire at once with exact entries; the Starter pack and the Growth lot are untouched; the chain holds", async () => {
    const { acc, ids } = await rig();
    const r = await revoke(acc, "pro", new Date().toISOString(), "canceled", "cancel-1");
    const l = await lotMap(acc);
    const e = await expireEntries(acc);
    const amounts = Object.fromEntries(e.map((x) => [x.lot, x.d]));
    const bal = await h.balance(acc);
    return r.ok && l[ids.topup].r === 0 && l[ids.pro].r === 0 && l[ids.starter].r === M(300) && l[ids.growth].r === M(1000) && amounts[ids.topup] === -M(1500) && amounts[ids.pro] === -M(6000) &&
      e.length === 2 && bal.spendable_micro === M(1300) && (await h.accountBalance(acc)) === M(1300) && (await invariants(h, acc)) === true;
  });
  t("cancel at the period end: the top-up stays spendable until that time, then expires through wallet_expire; both plan lots count as expiring, so they are drained before the pack and the later Growth lot", async () => {
    const end = h.future(8);
    const { acc, ids } = await rig(end);
    const r = await revoke(acc, "pro", end, "canceled", "cancel-2");
    const before = await h.balance(acc);
    await h.charge(acc, "post_publish", 6200, "spend");
    const spent = (await h.one(`select lot_breakdown from public.wallet_ledger where account_id = $1 and kind = 'charge'`, [acc])).lot_breakdown;
    const orderOk = spent.length === 2 && spent[0].lot_id === ids.pro && spent[0].units === M(6000) && spent[1].lot_id === ids.topup && spent[1].units === M(200);
    const mid = await lotMap(acc);
    await expireAt(new Date(Date.parse(end) + 1000).toISOString());
    const after = await lotMap(acc);
    return r.ok && r.expired_micro === 0 && before.spendable_micro === M(8800) && orderOk && mid[ids.topup].r === M(1300) && mid[ids.starter].r === M(300) && mid[ids.growth].r === M(1000) &&
      after[ids.topup].r === 0 && after[ids.starter].r === M(300) && after[ids.growth].r === M(1000) && (await expireEntries(acc)).map((x) => x.d).join() === `${-M(1300)}` && (await invariants(h, acc)) === true;
  });
  t("a top-up with a pending lapse is spent before an older non-expiring pack, and an unspent one is gone after the lapse time", async () => {
    const acc = await fresh();
    const pack = (await sku(acc, "lazycredits-starter-pack", "s", null)).lot_id;
    const top = (await sku(acc, "lazycredits-pro-top-up", "t", "pro")).lot_id;
    const end = h.future(5);
    await revoke(acc, "pro", end, "canceled", "k");
    await h.charge(acc, "post_publish", 10, "c");
    const l = await lotMap(acc);
    await expireAt(new Date(Date.parse(end) + 1000).toISOString());
    const after = await lotMap(acc);
    return l[top].r === M(1490) && l[pack].r === M(300) && after[top].r === 0 && after[pack].r === M(300);
  });
  t("revoke replay changes nothing; the same key with another plan, reason or lapse time is refused; bad reasons and lapse times beyond 40 days are refused", async () => {
    const { acc } = await rig();
    const end = h.future(10);
    const a = await revoke(acc, "pro", end, "canceled", "k");
    const n = await h.ledgerCount(acc);
    const b = await revoke(acc, "pro", end, "canceled", "k");
    const conflict = (sql) => h.fails(sql, "23505", [acc, end], "idempotency_conflict");
    return a.ok && b.replay === true && (await h.ledgerCount(acc)) === n &&
      (await conflict(`select public.wallet_revoke_plan($1::uuid, 'growth', $2::timestamptz, 'canceled', 'k')`)) === true &&
      (await conflict(`select public.wallet_revoke_plan($1::uuid, 'pro', $2::timestamptz, 'refund', 'k')`)) === true &&
      (await conflict(`select public.wallet_revoke_plan($1::uuid, 'pro', $2::timestamptz + interval '1 day', 'canceled', 'k')`)) === true &&
      (await h.fails(`select public.wallet_revoke_plan($1::uuid, 'pro', now(), 'because', 'z1')`, "22023", [acc])) === true &&
      (await h.fails(`select public.wallet_revoke_plan($1::uuid, 'pro', now() + interval '41 days', 'canceled', 'z2')`, "22023", [acc])) === true &&
      (await h.fails(`select public.wallet_revoke_plan($1::uuid, 'pro', null, 'canceled', 'z3')`, "22023", [acc])) === true;
  });
  t("a top-up bought after the lapse is refused without the Pro plan, and a later Pro does not resurrect the lapsed credits", async () => {
    const { acc, ids } = await rig();
    await revoke(acc, "pro", new Date().toISOString(), "terminated", "k");
    const refused = await sku(acc, "lazycredits-pro-top-up", "again-1", null);
    const bought = await sku(acc, "lazycredits-pro-top-up", "again-2", "pro");
    const l = await lotMap(acc);
    return refused.reason === "plan_required" && bought.ok && l[ids.topup].r === 0 && l[bought.lot_id].r === M(1500) && (await h.accountBalance(acc)) === M(1300 + 1500);
  });
  t("a hold in flight at the lapse stays valid: commit consumes it; a release lets those units expire right after", async () => {
    const mk = async () => {
      const acc = await fresh();
      const top = (await sku(acc, "lazycredits-pro-top-up", "t", "pro")).lot_id;
      const hd = await h.hold(acc, "competitor_teardown", "h");
      await revoke(acc, "pro", new Date().toISOString(), "chargeback", "k");
      return { acc, top, hd };
    };
    const a = await mk();
    const mid = (await h.lots(a.acc))[0];
    const c = await h.commit(a.hd.hold_id);
    const b = await mk();
    await h.release(b.hd.hold_id);
    const ex = await expireEntries(b.acc);
    return mid.r === M(10) && mid.h === M(10) && c.ok && (await h.accountBalance(a.acc)) === 0 && ex.map((x) => x.d).join() === `${-M(1490)},${-M(10)}` && (await h.accountBalance(b.acc)) === 0 && (await invariants(h, b.acc)) === true;
  });

  t("policy: past_due_retry is a no-op (no_lapse, no ledger entry); recovered leaves every lot and the balance identical", async () => {
    const { acc } = await rig();
    const before = JSON.stringify(await h.lots(acc));
    const n = await h.ledgerCount(acc);
    const a = await event(acc, "pro", "past_due_retry", null, "pd-1");
    const b = await event(acc, "pro", "past_due_retry", null, "pd-1");
    return a.outcome === "no_lapse" && b.outcome === "no_lapse" && JSON.stringify(await h.lots(acc)) === before && (await h.ledgerCount(acc)) === n && (await h.accountBalance(acc)) === M(8800);
  });
  t("policy: past_due_retry then billing_gave_up lapses the plan's lots at that moment; other plans and the Starter pack are untouched", async () => {
    const { acc, ids } = await rig();
    await event(acc, "pro", "past_due_retry", null, "pd-1");
    const r = await event(acc, "pro", "billing_gave_up", null, "gu-1");
    const l = await lotMap(acc);
    return r.ok && l[ids.topup].r === 0 && l[ids.pro].r === 0 && l[ids.growth].r === M(1000) && l[ids.starter].r === M(300) && (await expireEntries(acc)).length === 2 && (await invariants(h, acc)) === true;
  });
  t("policy: voluntary_cancel mid-cycle keeps the top-up and the plan lot spendable now (expiring first), and both are gone after wallet_expire at period_end; the Starter pack is untouched", async () => {
    const end = h.future(10);
    const { acc, ids } = await rig(end);
    const r = await event(acc, "pro", "voluntary_cancel", end, "vc-1");
    const spendable = (await h.balance(acc)).spendable_micro;
    await h.charge(acc, "post_publish", 7000, "spend");
    const spent = (await h.one(`select lot_breakdown from public.wallet_ledger where account_id = $1 and kind = 'charge'`, [acc])).lot_breakdown;
    const orderOk = spent[0].lot_id === ids.pro && spent[0].units === M(6000) && spent[1].lot_id === ids.topup && spent[1].units === M(1000) && spent.length === 2;
    await expireAt(new Date(Date.parse(end) + 1000).toISOString());
    const l = await lotMap(acc);
    return r.ok && spendable === M(8800) && orderOk && l[ids.topup].r === 0 && l[ids.pro].r === 0 && l[ids.starter].r === M(300) && l[ids.growth].r === M(1000) && (await invariants(h, acc)) === true;
  });
  t("policy: voluntary_cancel needs a period_end that is in the future and at most 40 days ahead", async () => {
    const { acc } = await rig();
    const bad = (end) => h.fails(`select public.wallet_handle_plan_event($1::uuid, 'pro', 'voluntary_cancel', $2::timestamptz, $3, now())`, "22023", [acc, end, `b${Math.random()}`]);
    return (await bad(null)) === true && (await bad(new Date(Date.now() - 60_000).toISOString())) === true && (await bad(h.future(41))) === true;
  });
  t("policy: cancel, then re-subscribe to Pro before period end: the old top-up still lapses at the original period end; the new plan lots are new lots", async () => {
    const end = h.future(10);
    const { acc, ids } = await rig(end);
    await event(acc, "pro", "voluntary_cancel", end, "vc-1");
    const fresh2 = (await sku(acc, "lazyrelay-pro-plan", "pro-2", null, h.future(40))).lot_id;
    await expireAt(new Date(Date.parse(end) + 1000).toISOString());
    const l = await lotMap(acc);
    return fresh2 !== ids.pro && l[ids.topup].r === 0 && l[ids.pro].r === 0 && l[fresh2].r === M(6000) && l[ids.starter].r === M(300) && (await invariants(h, acc)) === true;
  });
  t("policy: chargeback, refund and admin_termination lapse the same lots immediately", async () => {
    for (const ev of ["chargeback", "refund", "admin_termination"]) {
      const { acc, ids } = await rig();
      const r = await event(acc, "pro", ev, null, `ev-${ev}`);
      const l = await lotMap(acc);
      if (!r.ok || l[ids.topup].r !== 0 || l[ids.pro].r !== 0 || l[ids.starter].r !== M(300) || (await h.accountBalance(acc)) !== M(1300)) return `${ev}: wrong result`;
    }
    return true;
  });
  t("policy: replaying each event with the same key changes nothing, and the same key with another event or plan is refused", async () => {
    for (const [ev, end] of [["billing_gave_up", null], ["chargeback", null], ["refund", null], ["admin_termination", null], ["voluntary_cancel", h.future(10)]]) {
      const { acc } = await rig();
      const first = await event(acc, "pro", ev, end, "k");
      const n = await h.ledgerCount(acc);
      const lots = JSON.stringify(await h.lots(acc));
      const again = await event(acc, "pro", ev, end, "k");
      const other = ev === "refund" ? "chargeback" : "refund";
      const c1 = await h.fails(`select public.wallet_handle_plan_event($1::uuid, 'pro', $2, $3::timestamptz, 'k', now())`, "23505", [acc, other, end], "idempotency_conflict");
      const c2 = await h.fails(`select public.wallet_handle_plan_event($1::uuid, 'growth', $2, $3::timestamptz, 'k', now())`, "23505", [acc, ev, end], "idempotency_conflict");
      if (!first.ok || again.replay !== true || (await h.ledgerCount(acc)) !== n || JSON.stringify(await h.lots(acc)) !== lots || c1 !== true || c2 !== true) return `${ev}: replay or conflict wrong`;
    }
    return true;
  });
  t("policy: an unknown event name is refused with unknown_event", async () => {
    const { acc } = await rig();
    return (await h.fails(`select public.wallet_handle_plan_event($1::uuid, 'pro', 'payment_failed', null, 'k', now())`, "22023", [acc], "unknown_event")) === true &&
      (await h.fails(`select public.wallet_handle_plan_event($1::uuid, 'pro', null, null, 'k2', now())`, "22023", [acc], "unknown_event")) === true;
  });
  return checks;
}
