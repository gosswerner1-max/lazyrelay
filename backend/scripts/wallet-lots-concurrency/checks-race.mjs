// Checks (e) to (g): a charge racing the expiry instant, deadlock freedom under mixed load, and the ledger chain afterwards.
import { accountProblem } from "./fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (detail) => ({ pass: false, detail });

/** Milliseconds until the given moment on the DATABASE clock (negative once it has passed). */
async function msUntil(ctx, at) {
  const r = await ctx.run(ctx.clients[0], `select (extract(epoch from ($1::timestamptz - clock_timestamp())) * 1000)::float8 as ms`, [at]);
  return r[0].ms;
}

/** One burst of parallel work: charges, wallet_expire calls and a hold, all fired together on separate connections. */
function burst(ctx, acc, tag) {
  const ops = [];
  for (let i = 0; i < ctx.size; i++) {
    const c = ctx.clients[i];
    if (i % 4 === 3) ops.push(ctx.call(c, `fx.wallet_expire(now())`));
    else if (i % 8 === 6) ops.push(ctx.call(c, `fx.wallet_hold($1::uuid, 'post_publish', $2)`, [acc, `${tag}-h${i}`]));
    else ops.push(ctx.call(c, `fx.wallet_charge($1::uuid, 'post_publish', 1, $2)`, [acc, `${tag}-c${i}`]));
  }
  return ctx.settle(ops);
}

/** (e) bursts of charges, holds and wallet_expire around the expiry instant: nothing is spent from, or reserved on, a lot at or after its expiry. */
export async function checkExpiryRace(ctx) {
  const acc = await ctx.newAccount();
  await ctx.grant(acc, "pack", 5, null, ctx.key("g"));
  const expiry = (await ctx.run(ctx.clients[0], `select now() + interval '3 seconds' as t`))[0].t;
  await ctx.call(ctx.clients[0], `fx.wallet_grant($1::uuid, 'subscription', 1000000000, $2::timestamptz, $3)`, [acc, expiry, ctx.key("sub")]);
  for (let ms = await msUntil(ctx, expiry); ms > 120; ms = await msUntil(ctx, expiry)) await sleep(Math.min(ms - 100, 500));
  const tag = ctx.key("race");
  let before = 0;
  let after = 0;
  let errors = 0;
  for (let round = 0; (await msUntil(ctx, expiry)) > -400 && round < 400; round++) {
    const wasBefore = (await msUntil(ctx, expiry)) > 0;
    const res = await burst(ctx, acc, `${tag}-${round}`);
    errors += res.filter((r) => !r.ok).length;
    if (wasBefore) before += res.length;
    else after += res.length;
  }
  const late = await ctx.run(ctx.clients[0], `select
    (select count(*) from ${ctx.fx}.wallet_ledger l, jsonb_array_elements(l.lot_breakdown) e, ${ctx.fx}.wallet_lots lt
       where l.account_id = $1 and l.kind in ('charge', 'hold_commit') and lt.id = (e ->> 'lot_id')::uuid and lt.expires_at is not null and l.created_at >= lt.granted_expires_at)::int as spent_late,
    (select count(*) from ${ctx.fx}.wallet_holds h, jsonb_array_elements(h.breakdown) e, ${ctx.fx}.wallet_lots lt
       where h.account_id = $1 and lt.id = (e ->> 'lot_id')::uuid and lt.expires_at is not null and h.created_at >= lt.granted_expires_at)::int as held_late,
    (select count(*) from ${ctx.fx}.wallet_ledger where account_id = $1 and kind = 'expire')::int as expire_entries`, [acc]);
  const problem = await accountProblem(ctx, acc);
  const detail = `${before} operations before and ${after} after the expiry instant; spent after expiry: ${late[0].spent_late}, reserved after expiry: ${late[0].held_late}, expire entries: ${late[0].expire_entries}`;
  if (before === 0 || after === 0 || late[0].expire_entries < 1) return fail(`${detail}; the race window was not exercised`);
  return late[0].spent_late === 0 && late[0].held_late === 0 && errors === 0 && problem === null ? { pass: true, detail } : fail(`${detail}; errors ${errors}; ${problem ?? ""}`);
}

function pickOp(rnd) {
  const p = rnd();
  if (p < 0.3) return "charge";
  if (p < 0.5) return "hold";
  if (p < 0.62) return "commit";
  if (p < 0.7) return "release";
  if (p < 0.78) return "grant_pack";
  if (p < 0.83) return "grant_sub";
  if (p < 0.9) return "expire";
  if (p < 0.96) return "expire_holds";
  return "revoke";
}

async function runOp(ctx, c, kind, acc, open, n, rnd) {
  const key = `mix-${n}`;
  if (kind === "charge") return ctx.call(c, `fx.wallet_charge($1::uuid, 'post_publish', $2, $3)`, [acc, 1 + Math.floor(rnd() * 3), key]);
  if (kind === "hold") {
    const r = await ctx.call(c, `fx.wallet_hold($1::uuid, $2, $3)`, [acc, rnd() < 0.5 ? "post_publish" : "competitor_teardown", key]);
    if (r.ok && r.hold_id) open.push(r.hold_id);
    return r;
  }
  if ((kind === "commit" || kind === "release") && open.length > 0) {
    const id = open.splice(Math.floor(rnd() * open.length), 1)[0];
    return ctx.call(c, `fx.wallet_${kind}($1::uuid)`, [id]);
  }
  if (kind === "grant_pack") return ctx.call(c, `fx.wallet_grant($1::uuid, 'pack', $2::bigint, null, $3)`, [acc, (1 + Math.floor(rnd() * 20)) * 1_000_000, key]);
  if (kind === "grant_sub") return ctx.call(c, `fx.wallet_grant($1::uuid, 'subscription', $2::bigint, now() + interval '2 days', $3)`, [acc, (1 + Math.floor(rnd() * 20)) * 1_000_000, key]);
  if (kind === "expire") return ctx.call(c, `fx.wallet_expire(now())`);
  if (kind === "expire_holds") return ctx.call(c, `fx.wallet_expire_holds(now() + interval '20 minutes')`);
  return ctx.call(c, `fx.wallet_revoke_plan($1::uuid, 'pro', now(), 'canceled', $2)`, [acc, key]);
}

/** (f) 200 mixed operations from every connection across 3 accounts: no deadlock, no unexpected error. */
export async function checkDeadlockFreedom(ctx, accounts) {
  let seed = 90210;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const acc of accounts) {
    await ctx.grant(acc, "pack", 200, null, ctx.key("seed"));
    await ctx.call(ctx.clients[0], `fx.wallet_grant($1::uuid, 'subscription', 100000000, now() + interval '1 day', $2)`, [acc, ctx.key("seed-sub")]);
  }
  const plan = Array.from({ length: 200 }, (_, i) => ({ i, kind: pickOp(rnd), acc: accounts[Math.floor(rnd() * accounts.length)] }));
  const open = [];
  let next = 0;
  const codes = {};
  const worker = async (w) => {
    while (next < plan.length) {
      const step = plan[next++];
      try {
        await runOp(ctx, ctx.clients[w], step.kind, step.acc, open, step.i, rnd);
      } catch (e) {
        codes[e.code ?? "none"] = (codes[e.code ?? "none"] ?? 0) + 1;
      }
    }
  };
  await Promise.all(ctx.clients.map((_, w) => worker(w)));
  const total = Object.values(codes).reduce((a, b) => a + b, 0);
  const detail = `200 mixed operations from ${ctx.size} connections across ${accounts.length} accounts: ${codes["40P01"] ?? 0} deadlocks, ${total} errors${total ? ` (${JSON.stringify(codes)})` : ""}`;
  return total === 0 ? { pass: true, detail } : fail(detail);
}

/** (g) after everything: every account the run touched has a balanced, consistent ledger. */
export async function checkLedgerChains(ctx) {
  const ids = (await ctx.run(ctx.clients[0], `select account_id from ${ctx.fx}.wallet_accounts order by account_id`)).map((r) => r.account_id);
  const entries = (await ctx.run(ctx.clients[0], `select count(*)::int as n from ${ctx.fx}.wallet_ledger`))[0].n;
  for (const id of ids) {
    const problem = await accountProblem(ctx, id);
    if (problem) return fail(`account ${id.slice(-6)}: ${problem}`);
  }
  return { pass: true, detail: `${ids.length} accounts and ${entries} ledger entries: running balances chain, balances equal the lots, reserved equals the open holds` };
}
