// Checks (a) to (d): overdraft, idempotency, commit against release, duplicate grants. Each returns { pass, detail }.
import { tallyTerminal } from "./lib.mjs";
import { accountProblem } from "./fixture.mjs";

const M = (credits) => credits * 1_000_000;
const fail = (detail) => ({ pass: false, detail });
const spread = (ctx, count, make) => ctx.parallel(count, make);

/** (a1) 60 parallel one credit charges against 25 credits: exactly 25 succeed and the balance ends at zero. */
export async function checkParallelCharges(ctx) {
  const acc = await ctx.newAccount();
  await ctx.grant(acc, "pack", 25, null, ctx.key("g"));
  const run = ctx.key("c");
  const res = await ctx.settle(spread(ctx, 60, (c, i) => ctx.call(c, `fx.wallet_charge($1::uuid, 'post_publish', 1, $2)`, [acc, `${run}-${i}`])));
  const okN = res.filter((r) => r.ok && r.value.ok === true && r.value.replay === false).length;
  const refused = res.filter((r) => r.ok && r.value.ok === false && r.value.reason === "insufficient_credits").length;
  const rows = (await ctx.run(ctx.clients[0], `select count(*)::int as n from ${ctx.fx}.wallet_ledger where account_id = $1 and kind = 'charge'`, [acc]))[0].n;
  const problem = await accountProblem(ctx, acc);
  const detail = `60 parallel charges against 25 credits: ${okN} succeeded, ${refused} refused, ${rows} ledger rows`;
  return okN === 25 && refused === 35 && rows === 25 && problem === null ? { pass: true, detail } : fail(`${detail}; ${problem ?? "counts wrong"}`);
}

/** (a2) 30 parallel charges of 1 to 7 credits against 100 credits: the spent total never exceeds the balance and the balance never goes negative. */
export async function checkMixedSizeCharges(ctx) {
  const acc = await ctx.newAccount();
  await ctx.grant(acc, "pack", 100, null, ctx.key("g"));
  const run = ctx.key("m");
  const res = await ctx.settle(spread(ctx, 30, (c, i) => ctx.call(c, `fx.wallet_charge($1::uuid, 'post_publish', $2, $3)`, [acc, 1 + (i % 7), `${run}-${i}`])));
  const spent = res.filter((r) => r.ok && r.value.ok === true).reduce((a, r) => a + r.value.charged_micro, 0);
  const bal = (await ctx.run(ctx.clients[0], `select balance_micro::float8 as b from ${ctx.fx}.wallet_accounts where account_id = $1`, [acc]))[0].b;
  const problem = await accountProblem(ctx, acc);
  const detail = `30 parallel charges of 1 to 7 credits against 100: spent ${spent / 1e6}, balance left ${bal / 1e6}`;
  return spent <= M(100) && bal >= 0 && spent + bal === M(100) && problem === null ? { pass: true, detail } : fail(`${detail}; ${problem ?? "totals wrong"}`);
}

/** (a3) 24 parallel teardown holds against 100 credits: exactly 10 succeed and all 100 credits end up reserved. */
export async function checkParallelHolds(ctx) {
  const acc = await ctx.newAccount();
  await ctx.grant(acc, "pack", 100, null, ctx.key("g"));
  const run = ctx.key("h");
  const res = await ctx.settle(spread(ctx, 24, (c, i) => ctx.call(c, `fx.wallet_hold($1::uuid, 'competitor_teardown', $2)`, [acc, `${run}-${i}`])));
  const okN = res.filter((r) => r.ok && r.value.ok === true).length;
  const refused = res.filter((r) => r.ok && r.value.ok === false && r.value.reason === "insufficient_credits").length;
  const reserved = (await ctx.run(ctx.clients[0], `select coalesce(sum(reserved_units), 0)::float8 as h from ${ctx.fx}.wallet_lots where account_id = $1`, [acc]))[0].h;
  const problem = await accountProblem(ctx, acc);
  const detail = `24 parallel teardown holds against 100 credits: ${okN} held, ${refused} refused, ${reserved / 1e6} credits reserved`;
  return okN === 10 && refused === 14 && reserved === M(100) && problem === null ? { pass: true, detail } : fail(`${detail}; ${problem ?? "counts wrong"}`);
}

/** (b) the same idempotency key in parallel: one hold, one charge, and a different action on the same key is refused. */
export async function checkSameKey(ctx) {
  const acc = await ctx.newAccount();
  await ctx.grant(acc, "pack", 50, null, ctx.key("g"));
  const hk = ctx.key("same-hold");
  const holds = await ctx.settle(spread(ctx, 24, (c) => ctx.call(c, `fx.wallet_hold($1::uuid, 'competitor_teardown', $2)`, [acc, hk])));
  const ids = new Set(holds.filter((r) => r.ok && r.value.ok).map((r) => r.value.hold_id));
  const fresh = holds.filter((r) => r.ok && r.value.ok && r.value.replay === false).length;
  const rowsH = (await ctx.run(ctx.clients[0], `select count(*)::int as n from ${ctx.fx}.wallet_holds where account_id = $1 and idempotency_key = $2`, [acc, hk]))[0].n;
  const ck = ctx.key("same-charge");
  const charges = await ctx.settle(spread(ctx, 24, (c) => ctx.call(c, `fx.wallet_charge($1::uuid, 'post_publish', 2, $2)`, [acc, ck])));
  const freshC = charges.filter((r) => r.ok && r.value.ok && r.value.replay === false).length;
  const rowsC = (await ctx.run(ctx.clients[0], `select count(*)::int as n from ${ctx.fx}.wallet_ledger where account_id = $1 and idempotency_key = $2`, [acc, ck]))[0].n;
  const mixKey = ctx.key("mixed");
  const mixed = await ctx.settle(spread(ctx, 16, (c, i) => ctx.call(c, `fx.wallet_hold($1::uuid, $2, $3)`, [acc, i % 2 ? "post_publish" : "competitor_teardown", mixKey])));
  const rowsM = (await ctx.run(ctx.clients[0], `select count(*)::int as n from ${ctx.fx}.wallet_holds where account_id = $1 and idempotency_key = $2`, [acc, mixKey]))[0].n;
  const conflictsOk = mixed.every((r) => (r.ok && r.value.ok === true) || (!r.ok && r.code === "23505" && r.message.includes("idempotency_conflict")));
  const problem = await accountProblem(ctx, acc);
  const detail = `24 holds on one key: ${rowsH} row, ${ids.size} hold id, ${fresh} first answer; 24 charges on one key: ${rowsC} ledger row, ${freshC} first answer; 16 mixed-action holds on one key: ${rowsM} row`;
  const good = rowsH === 1 && ids.size === 1 && fresh === 1 && rowsC === 1 && freshC === 1 && rowsM === 1 && conflictsOk && problem === null;
  return good ? { pass: true, detail } : fail(`${detail}; ${problem ?? "see counts"}`);
}

/** (c) 20 rounds of 4 commits racing 4 releases on one hold: exactly one side wins each round and the other is refused cleanly. */
export async function checkCommitReleaseRace(ctx) {
  const acc = await ctx.newAccount();
  await ctx.grant(acc, "pack", 400, null, ctx.key("g"));
  const wins = { commit: 0, release: 0 };
  for (let round = 0; round < 20; round++) {
    const hold = await ctx.call(ctx.clients[0], `fx.wallet_hold($1::uuid, 'competitor_teardown', $2)`, [acc, ctx.key("r")]);
    const calls = spread(ctx, 8, (c, i) => (i % 2 === 0 ? ctx.call(c, `fx.wallet_commit($1::uuid)`, [hold.hold_id]) : ctx.call(c, `fx.wallet_release($1::uuid)`, [hold.hold_id])));
    const res = await ctx.settle(calls);
    if (res.some((r) => !r.ok)) return fail(`round ${round}: a call errored (${res.find((r) => !r.ok).code})`);
    const status = (await ctx.run(ctx.clients[0], `select status from ${ctx.fx}.wallet_holds where id = $1`, [hold.hold_id]))[0].status;
    const entries = (await ctx.run(ctx.clients[0], `select count(*)::int as n from ${ctx.fx}.wallet_ledger where hold_id = $1 and kind = 'hold_commit'`, [hold.hold_id]))[0].n;
    const verdict = tallyTerminal({ commits: res.filter((_, i) => i % 2 === 0).map((r) => r.value), releases: res.filter((_, i) => i % 2 === 1).map((r) => r.value), status, commitEntries: entries });
    if (!verdict.ok) return fail(`round ${round}: ${verdict.reason}`);
    wins[verdict.winner] += 1;
  }
  const problem = await accountProblem(ctx, acc);
  const detail = `20 rounds of 4 commits against 4 releases: commit won ${wins.commit}, release won ${wins.release}`;
  return problem === null ? { pass: true, detail } : fail(`${detail}; ${problem}`);
}

/** (d) duplicate grants: the same source key credits once, and only one signup lot can exist. */
export async function checkParallelGrants(ctx) {
  const acc = await ctx.newAccount();
  const sk = ctx.key("same-src");
  const res = await ctx.settle(spread(ctx, 16, (c) => ctx.call(c, `fx.wallet_grant($1::uuid, 'pack', 7000000, null, $2)`, [acc, sk])));
  const fresh = res.filter((r) => r.ok && r.value.replay === false).length;
  const answered = res.filter((r) => r.ok && r.value.ok === true).length;
  const lots = (await ctx.run(ctx.clients[0], `select count(*)::int as n, coalesce(sum(granted_units), 0)::float8 as g from ${ctx.fx}.wallet_lots where account_id = $1`, [acc]))[0];
  const sgn = await ctx.newAccount();
  const signups = await ctx.settle(spread(ctx, 12, (c, i) => ctx.call(c, `fx.wallet_grant($1::uuid, 'signup', 30000000, null, $2)`, [sgn, `signup-try-${i}`])));
  const okS = signups.filter((r) => r.ok).length;
  const refusedS = signups.filter((r) => !r.ok && r.code === "23505").length;
  const lotsS = (await ctx.run(ctx.clients[0], `select count(*)::int as n from ${ctx.fx}.wallet_lots where account_id = $1`, [sgn]))[0].n;
  const problem = (await accountProblem(ctx, acc)) ?? (await accountProblem(ctx, sgn));
  const detail = `16 grants on one source key: ${answered} answered, ${fresh} first answer, ${lots.n} lot, ${lots.g / 1e6} credits; 12 signup grants on 12 keys: ${okS} granted, ${refusedS} refused, ${lotsS} lot`;
  return answered === 16 && fresh === 1 && lots.n === 1 && lots.g === M(7) && okS === 1 && refusedS === 11 && lotsS === 1 && problem === null ? { pass: true, detail } : fail(`${detail}; ${problem ?? "see counts"}`);
}
