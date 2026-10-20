import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { WalletValueError } from "./money.js";
import { WALLET_PRICES_MICRO, isWalletAction, priceMicro } from "./prices.js";
import { WalletError, createWalletLedger, type WalletRpc } from "./ledger.js";
import { packSourceKey } from "./topup.js";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOLD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-11-01T10:00:00.000Z");

describe("prices, in micro credits", () => {
  it("a post is 1 credit and a competitor teardown is 10 credits; there is no youtube teardown", () => {
    expect(WALLET_PRICES_MICRO).toEqual({ post_publish: 1_000_000, competitor_teardown: 10_000_000 });
    expect(priceMicro("post_publish")).toBe(1_000_000);
    expect(priceMicro("competitor_teardown")).toBe(10_000_000);
    expect(isWalletAction("youtube_teardown")).toBe(false);
    expect(isWalletAction("api_dispatch")).toBe(false);
  });

  it("the code and the migration say the same numbers (drift guard)", () => {
    const sql = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations/0140_wallet_credit_lots.sql"), "utf8");
    expect(sql).toContain(`('post_publish', ${WALLET_PRICES_MICRO.post_publish}), ('competitor_teardown', ${WALLET_PRICES_MICRO.competitor_teardown})`);
  });

  it("refuses an action it does not know", () => {
    expect(() => priceMicro("free_money" as never)).toThrow(WalletValueError);
  });
});

function fakeRpc(handler: (fn: string, args: Record<string, unknown>) => { data?: unknown; error?: { message: string; code?: string } }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: WalletRpc = {
    async rpc(fn, args) {
      calls.push({ fn, args });
      const r = handler(fn, args);
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };
  return { client, calls };
}

describe("the ledger client calls the new function names and never sends an amount for a spend", () => {
  it("charge sends the ACTION and the COUNT of posts", async () => {
    const { client, calls } = fakeRpc(() => ({ data: { ok: true, replay: false, charged_micro: 3_000_000, balance_micro: 27_000_000 } }));
    const out = await createWalletLedger(client).charge({ accountId: ACCOUNT, action: "post_publish", units: 3, idempotencyKey: "post:123" });
    expect(out).toEqual({ ok: true, replay: false, chargedMicro: 3_000_000, balanceMicro: 27_000_000 });
    expect(calls).toEqual([{ fn: "wallet_charge", args: { p_account_id: ACCOUNT, p_action: "post_publish", p_units: 3, p_key: "post:123" } }]);
    expect(JSON.stringify(calls)).not.toMatch(/micro|amount|price|cost/i);
  });

  it("charge: a short balance is an answer, not an error, and the exempt answer is understood", async () => {
    const short = fakeRpc(() => ({ data: { ok: false, reason: "insufficient_credits", balance_micro: 100, required_micro: 1_000_000 } }));
    expect(await createWalletLedger(short.client).charge({ accountId: ACCOUNT, action: "post_publish", idempotencyKey: "k" })).toEqual({ ok: false, reason: "insufficient_credits", balanceMicro: 100, requiredMicro: 1_000_000 });
    const exempt = fakeRpc(() => ({ data: { ok: true, replay: false, exempt: true, charged_micro: 0, balance_micro: 0 } }));
    expect(await createWalletLedger(exempt.client).charge({ accountId: ACCOUNT, action: "post_publish", idempotencyKey: "k" })).toEqual({ ok: true, replay: false, exempt: true, chargedMicro: 0, balanceMicro: 0 });
  });

  it("hold sends the action and the key only", async () => {
    const { client, calls } = fakeRpc(() => ({ data: { ok: true, replay: false, hold_id: HOLD, held_micro: 10_000_000 } }));
    const out = await createWalletLedger(client).hold({ accountId: ACCOUNT, action: "competitor_teardown", idempotencyKey: "click:1" });
    expect(out).toEqual({ ok: true, replay: false, holdId: HOLD, heldMicro: 10_000_000 });
    expect(calls).toEqual([{ fn: "wallet_hold", args: { p_account_id: ACCOUNT, p_action: "competitor_teardown", p_key: "click:1" } }]);
  });

  it("hold: a short balance is an answer", async () => {
    const { client } = fakeRpc(() => ({ data: { ok: false, reason: "insufficient_credits", balance_micro: 9_000_000, required_micro: 10_000_000 } }));
    expect(await createWalletLedger(client).hold({ accountId: ACCOUNT, action: "competitor_teardown", idempotencyKey: "k" })).toEqual({ ok: false, reason: "insufficient_credits", balanceMicro: 9_000_000, requiredMicro: 10_000_000 });
  });

  it("commit and release send the hold id", async () => {
    const { client, calls } = fakeRpc((fn) => ({ data: fn === "wallet_commit" ? { ok: true, replay: false, committed_micro: 10_000_000, balance_micro: 5_000_000 } : { ok: true, replay: false } }));
    const ledger = createWalletLedger(client);
    expect(await ledger.commit(HOLD)).toEqual({ ok: true, replay: false, committedMicro: 10_000_000, balanceMicro: 5_000_000 });
    expect(await ledger.release(HOLD)).toEqual({ ok: true, replay: false });
    expect(calls).toEqual([{ fn: "wallet_commit", args: { p_hold_id: HOLD } }, { fn: "wallet_release", args: { p_hold_id: HOLD } }]);
  });

  it("commit on a hold that is no longer held is an answer", async () => {
    const { client } = fakeRpc(() => ({ data: { ok: false, reason: "hold_not_held", status: "expired" } }));
    expect(await createWalletLedger(client).commit(HOLD)).toEqual({ ok: false, reason: "hold_not_held", status: "expired" });
  });

  it("grant sends the kind, the units, the expiry and the source key", async () => {
    const { client, calls } = fakeRpc(() => ({ data: { ok: true, replay: false, lot_id: HOLD, granted_micro: 30_000_000, balance_micro: 30_000_000 } }));
    const out = await createWalletLedger(client).grant({ accountId: ACCOUNT, kind: "signup", credits: 30, sourceKey: `signup:${ACCOUNT}` });
    expect(out).toEqual({ ok: true, replay: false, lotId: HOLD, grantedMicro: 30_000_000, balanceMicro: 30_000_000 });
    expect(calls).toEqual([{ fn: "wallet_grant", args: { p_account_id: ACCOUNT, p_kind: "signup", p_units: 30_000_000, p_expires_at: null, p_source_key: `signup:${ACCOUNT}` } }]);
  });

  it("grantForSku sends the sku, the key, the clock, the plan and the period end, and never an amount", async () => {
    const { client, calls } = fakeRpc(() => ({ data: { ok: true, replay: false, sku: "lazyrelay-growth-plan", lot_id: HOLD, granted_micro: 1_000_000_000, balance_micro: 1_000_000_000 } }));
    const out = await createWalletLedger(client).grantForSku({ accountId: ACCOUNT, sku: "lazyrelay-growth-plan", sourceKey: "period:sub_1:2026-11-01", now: NOW, activePlan: null, periodEnd: new Date("2026-12-01T10:00:00.000Z") });
    expect(out).toMatchObject({ ok: true, lotId: HOLD, grantedMicro: 1_000_000_000 });
    expect(calls).toEqual([{ fn: "wallet_grant_for_sku", args: { p_account_id: ACCOUNT, p_sku: "lazyrelay-growth-plan", p_source_key: "period:sub_1:2026-11-01", p_now: NOW.toISOString(), p_active_plan: null, p_period_end: "2026-12-01T10:00:00.000Z" } }]);
    expect(JSON.stringify(calls)).not.toMatch(/units|amount|credits/i);
  });

  it("grantForSku: a plan_required refusal is an answer", async () => {
    const { client } = fakeRpc(() => ({ data: { ok: false, reason: "plan_required", required_plan: "pro" } }));
    expect(await createWalletLedger(client).grantForSku({ accountId: ACCOUNT, sku: "lazycredits-pro-top-up", sourceKey: "paddle:txn_1", now: NOW, activePlan: null })).toEqual({ ok: false, reason: "plan_required", requiredPlan: "pro" });
  });

  it("handlePlanEvent sends the plan, the event and the period end; past_due_retry is a no-op answer", async () => {
    const { client, calls } = fakeRpc(() => ({ data: { ok: true, outcome: "no_lapse" } }));
    const out = await createWalletLedger(client).handlePlanEvent({ accountId: ACCOUNT, plan: "pro", event: "past_due_retry", idempotencyKey: "evt_1", now: NOW });
    expect(out).toEqual({ ok: true, outcome: "no_lapse" });
    expect(calls).toEqual([{ fn: "wallet_handle_plan_event", args: { p_account_id: ACCOUNT, p_plan: "pro", p_event: "past_due_retry", p_period_end: null, p_key: "evt_1", p_now: NOW.toISOString() } }]);
  });

  it("handlePlanEvent returns what lapsed", async () => {
    const { client } = fakeRpc(() => ({ data: { ok: true, replay: false, lots_revoked: 2, expired_micro: 7_500_000_000, lapse_at: "2026-11-01T10:00:00+00:00" } }));
    expect(await createWalletLedger(client).handlePlanEvent({ accountId: ACCOUNT, plan: "pro", event: "billing_gave_up", idempotencyKey: "evt_2", now: NOW })).toEqual({ ok: true, replay: false, lotsRevoked: 2, expiredMicro: 7_500_000_000 });
  });

  it("balance, expire and expireHolds call their functions", async () => {
    const { client, calls } = fakeRpc((fn) => ({ data: fn === "wallet_balance" ? { spendable_micro: 5, held_micro: 1, next_expiry_at: null, next_expiry_micro: null } : fn === "wallet_expire" ? { expired_lots: 1, expired_micro: 9 } : { expired_holds: 2 } }));
    const ledger = createWalletLedger(client);
    expect(await ledger.balance(ACCOUNT, NOW)).toEqual({ spendableMicro: 5, heldMicro: 1, nextExpiryAt: null, nextExpiryMicro: null });
    expect(await ledger.expire(NOW)).toEqual({ expiredLots: 1, expiredMicro: 9 });
    expect(await ledger.expireHolds(NOW)).toEqual({ expiredHolds: 2 });
    expect(calls.map((c) => c.fn)).toEqual(["wallet_balance", "wallet_expire", "wallet_expire_holds"]);
  });

  it.each([
    ["no account", { accountId: "", action: "post_publish" as const, idempotencyKey: "k" }],
    ["an unknown action", { accountId: ACCOUNT, action: "api_dispatch" as never, idempotencyKey: "k" }],
    ["zero units", { accountId: ACCOUNT, action: "post_publish" as const, units: 0, idempotencyKey: "k" }],
    ["fractional units", { accountId: ACCOUNT, action: "post_publish" as const, units: 1.5, idempotencyKey: "k" }],
    ["10,001 units", { accountId: ACCOUNT, action: "post_publish" as const, units: 10_001, idempotencyKey: "k" }],
    ["a key with spaces", { accountId: ACCOUNT, action: "post_publish" as const, idempotencyKey: "a b" }],
    ["a key over 128 characters", { accountId: ACCOUNT, action: "post_publish" as const, idempotencyKey: "k".repeat(129) }],
  ])("charge refuses %s before anything is sent", async (_name, input) => {
    const rpc = vi.fn();
    await expect(createWalletLedger({ rpc } as unknown as WalletRpc).charge(input)).rejects.toThrow(WalletValueError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("the other calls refuse bad input before anything is sent", async () => {
    const rpc = vi.fn();
    const ledger = createWalletLedger({ rpc } as unknown as WalletRpc);
    await expect(ledger.hold({ accountId: ACCOUNT, action: "youtube_teardown" as never, idempotencyKey: "k" })).rejects.toThrow(WalletValueError);
    await expect(ledger.commit("nope")).rejects.toThrow(WalletValueError);
    await expect(ledger.release("nope")).rejects.toThrow(WalletValueError);
    await expect(ledger.grant({ accountId: ACCOUNT, kind: "gift" as never, credits: 5, sourceKey: "k" })).rejects.toThrow(WalletValueError);
    await expect(ledger.grant({ accountId: ACCOUNT, kind: "pack", credits: 0, sourceKey: "k" })).rejects.toThrow(WalletValueError);
    await expect(ledger.grant({ accountId: ACCOUNT, kind: "subscription", credits: 5, sourceKey: "k" })).rejects.toThrow(WalletValueError);
    await expect(ledger.grantForSku({ accountId: ACCOUNT, sku: "free-money", sourceKey: "k", now: NOW, activePlan: null })).rejects.toThrow(WalletValueError);
    await expect(ledger.handlePlanEvent({ accountId: ACCOUNT, plan: "pro", event: "payment_failed" as never, idempotencyKey: "k", now: NOW })).rejects.toThrow(WalletValueError);
    await expect(ledger.handlePlanEvent({ accountId: ACCOUNT, plan: "pro", event: "voluntary_cancel", idempotencyKey: "k", now: NOW })).rejects.toThrow(WalletValueError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a database error becomes a WalletError with a fixed message that holds no database text", async () => {
    const { client } = fakeRpc(() => ({ error: { message: "connection to 10.0.0.5 refused for role secret_role", code: "08006" } }));
    const err = (await createWalletLedger(client).charge({ accountId: ACCOUNT, action: "post_publish", idempotencyKey: "k" }).catch((e: unknown) => e)) as WalletError;
    expect(err).toBeInstanceOf(WalletError);
    expect(err.message).toBe("the wallet is not available right now");
    expect(err.message + String(err.code)).not.toMatch(/10\.0\.0\.5|secret_role/);
  });

  it("a reused key with a different request is reported as a conflict, not retried", async () => {
    const { client } = fakeRpc(() => ({ error: { message: "idempotency_conflict", code: "23505" } }));
    const err = (await createWalletLedger(client).hold({ accountId: ACCOUNT, action: "competitor_teardown", idempotencyKey: "k" }).catch((e: unknown) => e)) as WalletError;
    expect(err.code).toBe("key_conflict");
    expect(err.message).toBe("this key was already used for a different change");
  });

  it("an answer in an unexpected shape is refused, not trusted", async () => {
    for (const data of [null, "ok", { ok: true }, { ok: true, replay: false, charged_micro: "2000", balance_micro: 1 }, { ok: true, replay: false, charged_micro: -5, balance_micro: 1 }, { ok: false, reason: "other" }]) {
      const { client } = fakeRpc(() => ({ data }));
      await expect(createWalletLedger(client).charge({ accountId: ACCOUNT, action: "post_publish", idempotencyKey: "k" }), JSON.stringify(data)).rejects.toThrow(WalletError);
    }
    const { client } = fakeRpc(() => ({ data: { ok: true, replay: false, hold_id: "nope", held_micro: 1 } }));
    await expect(createWalletLedger(client).hold({ accountId: ACCOUNT, action: "post_publish", idempotencyKey: "k" })).rejects.toThrow(WalletError);
  });
});

describe("source keys", () => {
  it("a pack sale is keyed by the Paddle transaction, so a replayed webhook grants once", () => {
    expect(packSourceKey("txn_01abc")).toBe("paddle:txn_01abc");
    expect(packSourceKey("txn_01abc")).toBe(packSourceKey("txn_01abc"));
  });

  it.each(["", "a b", "x".repeat(101), "txn;drop"])("refuses the transaction id %j", (id) => {
    expect(() => packSourceKey(id)).toThrow(WalletValueError);
  });
});
