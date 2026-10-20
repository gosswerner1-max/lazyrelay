// Checks (e) to (g): a charge racing the expiry instant, deadlock freedom under mixed load, and the ledger chain afterwards.
import { accountProblem } from "./fixture.mjs";
import { classifyByExpiry, leadMs, median, raceExercised } from "./lib.mjs";

const fail = (detail) => ({ pass: false, detail });

// Check (e) helpers. Every operation is stamped with now() INSIDE its own statement, which is the same transaction time the wallet
// functions use to decide whether a lot has expired, so the before and after split uses the database clock only.
async function calibrate(ctx) {
  const samples = [];
  await Promise.all(ctx.clients.map(async (c) => {
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await c.query("select 1");
      samples.push(performance.now() - t0);
    }
  }));
  return median(samples);
}

async function stamped(ctx, client, expr, params) {
  try {
    const row = (await ctx.run(client, `select now() as t, (${expr.split("fx.").join(`${ctx.fx}.`)}) as r`, params))[0];
    return { t: row.t, r: row.r };
  } catch (e) {
    return { t: null, error: e.code ?? "none" };
  }
}

/** One worker loops as fast as its connection allows until stopAt: charges and holds of 1 credit, and on every fourth connection wallet_expire. */
async function raceWorker(ctx, w, acc, tag, stopAt, ops) {
  const client = ctx.clients[w];
  for (let i = 0; Date.now() < stopAt; i++) {
    if (w % 4 === 3) ops.push(await stamped(ctx, client, `fx.wallet_expire(now())`));
    else if (i % 2 === 0) ops.push(await stamped(ctx, client, `fx.wallet_charge($1::uuid, 'post_publish', 1, $2)`, [acc, `${tag}-c${w}-${i}`]));
    else ops.push(await stamped(ctx, client, `fx.wallet_hold($1::uuid, 'post_publish', $2)`, [acc, `${tag}-h${w}-${i}`]));
  }
}

async function raceAttempt(ctx, lead, attempt) {
  const c0 = ctx.clients[0];
  const acc = await ctx.newAccount();
  await ctx.grant(acc, "pack", 5, null, ctx.key("g"));
  const expiry = (await ctx.run(c0, `select clock_timestamp() + make_interval(secs => $1::float8 / 1000) as t`, [lead]))[0].t;
  const sub = await ctx.call(c0, `fx.wallet_grant($1::uuid, 'subscription', 900000000000::bigint, $2::timestamptz, $3)`, [acc, expiry, ctx.key("sub")]);
  const ops = [];
  const stopAt = Date.now() + 2 * lead;
  await Promise.all(ctx.clients.map((_, w) => raceWorker(ctx, w, acc, `${ctx.key("race")}-${attempt}`, stopAt, ops)));
  return { acc, sub: sub.lot_id, expiry, ops };
}

async function raceViolations(ctx, { acc, sub }) {
  const r = (await ctx.run(ctx.clients[0], `select
    (select count(*) from ${ctx.fx}.wallet_ledger l, jsonb_array_elements(l.lot_breakdown) e, ${ctx.fx}.wallet_lots lt
       where l.account_id = $1 and l.kind in ('charge', 'hold_commit') and lt.id = (e ->> 'lot_id')::uuid and lt.expires_at is not null and l.created_at >= lt.granted_expires_at)::int as spent_late,
    (select count(*) from ${ctx.fx}.wallet_holds h, jsonb_array_elements(h.breakdown) e, ${ctx.fx}.wallet_lots lt
       where h.account_id = $1 and lt.id = (e ->> 'lot_id')::uuid and lt.expires_at is not null and h.created_at >= lt.granted_expires_at)::int as held_late,
    (select count(*) from ${ctx.fx}.wallet_ledger where account_id = $1 and kind = 'expire' and lot_breakdown -> 0 ->> 'lot_id' = $2)::int as expire_entries`, [acc, sub]))[0];
  return r;
}

/** (e) up to 3 attempts, each with a longer lead, until at least 20 operations ran before AND after the expiry instant (by database time). */
export async function checkExpiryRace(ctx) {
  const rtt = await calibrate(ctx);
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const lead = leadMs(rtt, attempt);
    const run = await raceAttempt(ctx, lead, attempt);
    const split = classifyByExpiry(run.ops, run.expiry);
    const errors = run.ops.filter((o) => o.error).length;
    const v = await raceViolations(ctx, run);
    const problem = await accountProblem(ctx, run.acc);
    last = `attempt ${attempt + 1} (median round trip ${rtt.toFixed(0)} ms, lead ${(lead / 1000).toFixed(1)} s): ${split.before} operations before and ${split.after} after the expiry instant; spent after expiry: ${v.spent_late}, reserved after expiry: ${v.held_late}, expire entries for the lot: ${v.expire_entries}, errors: ${errors}`;
    if (v.spent_late !== 0 || v.held_late !== 0 || errors !== 0 || problem !== null) return fail(`${last}; ${problem ?? "a correctness assertion failed"}`);
    if (!raceExercised(split)) continue;
    return v.expire_entries === 1 ? { pass: true, detail: last } : fail(`${last}; expected exactly one expire entry`);
  }
  return fail(`${last}; the race window was not exercised`);
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
