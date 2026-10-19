import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { MICRO_PER_USD, WalletValueError, assertPositiveMicro, microToUsd, minorUnitsToMicro, usdToPositiveMicro } from "./money.js";
import { WALLET_PRICES_MICRO, priceMicro } from "./prices.js";
import { walletEnabled } from "./flags.js";
import { WalletError, createWalletLedger, type WalletRpc } from "./ledger.js";
import { walletCreditFromSale } from "./topup.js";
import { ENTERPRISE_CAP_PROPOSAL, FREE_BRAND_CAP_LOCKED, LIVE_TIERS, WALLET_PLAN_PROPOSAL, enterpriseProposalKeepsTheLadder, dailyPostCapReached, maxFreeConnections, maxFreeDailyPublications, paidTiersOutgivenByFree, paidTiersUndercutByEnterprise } from "./plans.proposal.js";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("money: whole micro dollars, never floating point", () => {
  it("1 USD is 1,000,000 micro", () => expect(MICRO_PER_USD).toBe(1_000_000));

  it.each([
    ["0.002", 2000],
    ["0.05", 50_000],
    ["5", 5_000_000],
    ["12.345678", 12_345_678],
    ["0.000001", 1],
  ])("reads the decimal string %s as %i micro exactly", (text, micro) => expect(usdToPositiveMicro(text)).toBe(micro));

  it.each(["0", "0.0", "0.000000", "-1", "-0.002", "+1", "1e3", "1,5", " 1", "1 ", "", "abc", "0.0000001", "1.", ".5", "NaN", "Infinity", "1000000000000"])(
    "refuses %j (zero, negative, odd formats, more than 6 decimals, over the cap)",
    (text) => expect(() => usdToPositiveMicro(text)).toThrow(WalletValueError),
  );

  it("refuses a JavaScript number, so a float can never be used as money", () => {
    expect(() => usdToPositiveMicro(0.002 as unknown as string)).toThrow(WalletValueError);
  });

  it("formats micro back as a minimal decimal string", () => {
    expect(microToUsd(2000)).toBe("0.002");
    expect(microToUsd(50_000)).toBe("0.05");
    expect(microToUsd(5_000_000)).toBe("5");
    expect(microToUsd(1)).toBe("0.000001");
    expect(microToUsd(0)).toBe("0");
  });

  it("round trips every price", () => {
    for (const micro of Object.values(WALLET_PRICES_MICRO)) expect(usdToPositiveMicro(microToUsd(micro))).toBe(micro);
  });

  it("assertPositiveMicro accepts only whole positive safe numbers up to 1,000,000,000,000", () => {
    expect(assertPositiveMicro(1)).toBe(1);
    expect(assertPositiveMicro(1_000_000_000_000)).toBe(1_000_000_000_000);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_000_001, "5", null, undefined, 2 ** 60]) expect(() => assertPositiveMicro(bad), String(bad)).toThrow(WalletValueError);
  });

  it("Paddle amounts are in the smallest currency unit: 500 means 5.00 USD, which is 5,000,000 micro", () => {
    expect(minorUnitsToMicro("500")).toBe(5_000_000);
    expect(minorUnitsToMicro("1")).toBe(10_000);
    for (const bad of ["0", "-500", "5.00", "1e3", "", " 500", "abc"]) expect(() => minorUnitsToMicro(bad), bad).toThrow(WalletValueError);
  });
});

describe("prices", () => {
  it("a verified platform dispatch costs 0.002 USD and a sitemap sync costs 0.05 USD", () => {
    expect(priceMicro("api_dispatch")).toBe(2000);
    expect(priceMicro("sitemap_sync")).toBe(50_000);
    expect(microToUsd(priceMicro("api_dispatch"))).toBe("0.002");
    expect(microToUsd(priceMicro("sitemap_sync"))).toBe("0.05");
  });

  it("every price is strictly positive", () => {
    for (const micro of Object.values(WALLET_PRICES_MICRO)) expect(micro).toBeGreaterThan(0);
  });

  it("the code and the migration say the same numbers (drift guard)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(resolve(here, "../../supabase/migrations/0139_wallet_ledger.sql"), "utf8");
    expect(sql).toContain(`('api_dispatch', ${WALLET_PRICES_MICRO.api_dispatch}), ('sitemap_sync', ${WALLET_PRICES_MICRO.sitemap_sync})`);
  });

  it("refuses an action it does not know", () => {
    expect(() => priceMicro("free_money" as never)).toThrow(WalletValueError);
  });
});

describe("the switch", () => {
  it("is on only when WALLET_ENABLED is exactly the word true", () => {
    expect(walletEnabled({ WALLET_ENABLED: "true" })).toBe(true);
    for (const v of [undefined, "", "TRUE", "True", "1", "yes", "true ", " true", "on"]) expect(walletEnabled({ WALLET_ENABLED: v }), String(v)).toBe(false);
    expect(walletEnabled({})).toBe(false);
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

describe("the ledger client", () => {
  it("charge sends the ACTION and the unit count, never an amount, and returns the parsed answer", async () => {
    const { client, calls } = fakeRpc(() => ({ data: { ok: true, replay: false, charged_micro: 2000, balance_micro: 4_998_000 } }));
    const out = await createWalletLedger(client).charge({ accountId: ACCOUNT, action: "api_dispatch", idempotencyKey: "post:123:mastodon" });
    expect(out).toEqual({ ok: true, replay: false, chargedMicro: 2000, balanceMicro: 4_998_000 });
    expect(calls).toEqual([{ fn: "wallet_charge", args: { p_account_id: ACCOUNT, p_action: "api_dispatch", p_units: 1, p_key: "post:123:mastodon" } }]);
    expect(JSON.stringify(calls)).not.toMatch(/micro|amount|price|cost/i);
  });

  it("an insufficient balance is an answer, not an error", async () => {
    const { client } = fakeRpc(() => ({ data: { ok: false, reason: "insufficient_funds", balance_micro: 100, required_micro: 2000 } }));
    expect(await createWalletLedger(client).charge({ accountId: ACCOUNT, action: "api_dispatch", idempotencyKey: "k" })).toEqual({
      ok: false, reason: "insufficient_funds", balanceMicro: 100, requiredMicro: 2000,
    });
  });

  it("credit sends a strictly positive whole amount", async () => {
    const { client, calls } = fakeRpc(() => ({ data: { ok: true, replay: false, credited_micro: 5_000_000, balance_micro: 5_000_000 } }));
    const out = await createWalletLedger(client).credit({ accountId: ACCOUNT, amountMicro: 5_000_000, idempotencyKey: "paddle:txn_1", reference: "txn_1" });
    expect(out).toEqual({ ok: true, replay: false, creditedMicro: 5_000_000, balanceMicro: 5_000_000 });
    expect(calls[0]).toEqual({ fn: "wallet_credit", args: { p_account_id: ACCOUNT, p_amount_micro: 5_000_000, p_key: "paddle:txn_1", p_reference: "txn_1", p_kind: "top_up" } });
  });

  it.each([
    ["no account", { accountId: "", action: "api_dispatch" as const, idempotencyKey: "k" }],
    ["a malformed account id", { accountId: "not-a-uuid", action: "api_dispatch" as const, idempotencyKey: "k" }],
    ["an unknown action", { accountId: ACCOUNT, action: "free_money" as never, idempotencyKey: "k" }],
    ["zero units", { accountId: ACCOUNT, action: "api_dispatch" as const, units: 0, idempotencyKey: "k" }],
    ["negative units", { accountId: ACCOUNT, action: "api_dispatch" as const, units: -3, idempotencyKey: "k" }],
    ["fractional units", { accountId: ACCOUNT, action: "api_dispatch" as const, units: 1.5, idempotencyKey: "k" }],
    ["10,001 units", { accountId: ACCOUNT, action: "api_dispatch" as const, units: 10_001, idempotencyKey: "k" }],
    ["an empty key", { accountId: ACCOUNT, action: "api_dispatch" as const, idempotencyKey: "" }],
    ["a key with spaces", { accountId: ACCOUNT, action: "api_dispatch" as const, idempotencyKey: "a b" }],
    ["a key over 128 characters", { accountId: ACCOUNT, action: "api_dispatch" as const, idempotencyKey: "k".repeat(129) }],
  ])("charge refuses %s before anything is sent", async (_name, input) => {
    const rpc = vi.fn();
    await expect(createWalletLedger({ rpc } as unknown as WalletRpc).charge(input)).rejects.toThrow(WalletValueError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, 1_000_000_000_001])("credit refuses the amount %s before anything is sent", async (amountMicro) => {
    const rpc = vi.fn();
    await expect(createWalletLedger({ rpc } as unknown as WalletRpc).credit({ accountId: ACCOUNT, amountMicro, idempotencyKey: "k" })).rejects.toThrow(WalletValueError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a database error becomes a WalletError with a fixed message that holds no database text", async () => {
    const { client } = fakeRpc(() => ({ error: { message: "connection to 10.0.0.5 refused for role secret_role", code: "08006" } }));
    const err = (await createWalletLedger(client).charge({ accountId: ACCOUNT, action: "api_dispatch", idempotencyKey: "k" }).catch((e: unknown) => e)) as WalletError;
    expect(err).toBeInstanceOf(WalletError);
    expect(err.message).toBe("the wallet is not available right now");
    expect(err.message + String(err.code)).not.toMatch(/10\.0\.0\.5|secret_role/);
  });

  it("a reused key with a different change is reported as a conflict, not retried", async () => {
    const { client } = fakeRpc(() => ({ error: { message: "x", code: "23505" } }));
    const err = (await createWalletLedger(client).charge({ accountId: ACCOUNT, action: "api_dispatch", idempotencyKey: "k" }).catch((e: unknown) => e)) as WalletError;
    expect(err.code).toBe("key_conflict");
  });

  it("an answer in an unexpected shape is refused, not trusted", async () => {
    for (const data of [null, "ok", { ok: true }, { ok: true, replay: false, charged_micro: "2000", balance_micro: 1 }, { ok: true, replay: false, charged_micro: -5, balance_micro: 1 }, { ok: false, reason: "other" }]) {
      const { client } = fakeRpc(() => ({ data }));
      await expect(createWalletLedger(client).charge({ accountId: ACCOUNT, action: "api_dispatch", idempotencyKey: "k" }), JSON.stringify(data)).rejects.toThrow(WalletError);
    }
  });
});

describe("a top up from a Paddle sale credits what was paid BEFORE tax", () => {
  const sale = { currencyCode: "USD", total: "1000", tax: "150", grandTotal: "1150", paddleTransactionId: "txn_01abc" };

  it("credits the pre tax total (10.00 USD), not the 11.50 the customer was charged with tax", () => {
    expect(walletCreditFromSale({ sale, isWalletTopUp: true })).toEqual({ amountMicro: 10_000_000, idempotencyKey: "paddle:txn_01abc", reference: "txn_01abc" });
  });

  it("returns nothing for a sale that is not a wallet top up", () => {
    expect(walletCreditFromSale({ sale, isWalletTopUp: false })).toBeNull();
  });

  it("refuses another currency (it would be credited at the wrong value)", () => {
    expect(() => walletCreditFromSale({ sale: { ...sale, currencyCode: "EUR" }, isWalletTopUp: true })).toThrow(WalletValueError);
  });

  it.each(["0", "-1000", "10.00", "", "abc"])("refuses a total of %j", (total) => {
    expect(() => walletCreditFromSale({ sale: { ...sale, total }, isWalletTopUp: true })).toThrow(WalletValueError);
  });

  it("refuses a missing transaction id (no idempotency key means a replayed webhook could credit twice)", () => {
    expect(() => walletCreditFromSale({ sale: { ...sale, paddleTransactionId: "" }, isWalletTopUp: true })).toThrow(WalletValueError);
  });

  it("the same sale always produces the same key, so a replayed webhook credits once", () => {
    const a = walletCreditFromSale({ sale, isWalletTopUp: true });
    const b = walletCreditFromSale({ sale, isWalletTopUp: true });
    expect(a?.idempotencyKey).toBe(b?.idempotencyKey);
  });
});

describe("the plan proposal is data only (nothing reads it yet)", () => {
  it("Free Core: 3 brands, all 18 platforms in each, 3 publications a day per brand, no WhatsApp, no signed links", () => {
    expect(WALLET_PLAN_PROPOSAL.free).toEqual({ monthlyUsd: "0", brands: 3, platformsPerBrand: 18, dailyPostCapPerBrand: 3, whatsappWorkflows: false, signedProofLinks: false, whiteLabelReporting: false });
  });

  it("Enterprise at 99 USD: no brand limit, no seat limit, WhatsApp workflows and signed links", () => {
    expect(WALLET_PLAN_PROPOSAL.enterprise).toEqual({ monthlyUsd: "99", brands: null, teamSeats: null, whatsappWorkflows: true, signedProofLinks: true, customClientReporting: true });
    expect(WALLET_PLAN_PROPOSAL.status).toMatch(/proposal/i);
  });

  it("is clear about what is NOT built", () => {
    expect(WALLET_PLAN_PROPOSAL.notBuilt).toEqual(expect.arrayContaining(["customClientReporting", "whiteLabelReporting", "signedProofLinks"]));
  });

  it("what the structure allows in total: 54 connections and 9 publications a day on Free", () => {
    expect(maxFreeConnections()).toBe(54);
    expect(maxFreeDailyPublications()).toBe(9);
  });

  it("the cap is per brand and is reached at the cap, not before", () => {
    expect(dailyPostCapReached(2, 3)).toBe(false);
    expect(dailyPostCapReached(3, 3)).toBe(true);
    expect(dailyPostCapReached(4, 3)).toBe(true);
    for (const bad of [-1, 1.5, Number.NaN]) expect(() => dailyPostCapReached(bad, 3)).toThrow(WalletValueError);
    expect(() => dailyPostCapReached(0, 0)).toThrow(WalletValueError);
  });

  it("records the conflict with the live plans so it cannot be forgotten: Free would hold more connections than Starter, Pro and Business", () => {
    expect(paidTiersOutgivenByFree()).toEqual(["starter", "pro", "business"]);
  });

  it("records that Enterprise with no brand limit at 99 USD sits at or below the price of Business and below Agency and Agency Plus", () => {
    expect(paidTiersUndercutByEnterprise()).toEqual(["business", "agency", "agency_plus"]);
    expect(LIVE_TIERS.agency_plus.brands).toBe(20);
  });
});

describe("the brand cap structure", () => {
  it("Free is locked at 3 brands, and the structure's Free brands value agrees", () => {
    expect(FREE_BRAND_CAP_LOCKED).toBe(3);
    expect(WALLET_PLAN_PROPOSAL.free.brands).toBe(FREE_BRAND_CAP_LOCKED);
  });

  it("the Enterprise caps are marked as proposed, not approved", () => {
    expect(ENTERPRISE_CAP_PROPOSAL.status).toMatch(/proposed.*awaiting owner approval/);
  });

  it("the proposed Enterprise caps stay inside the live ladder (above Business, no more than Agency, priced below Agency)", () => {
    expect(enterpriseProposalKeepsTheLadder()).toBe(true);
    expect(ENTERPRISE_CAP_PROPOSAL.brandsIncluded * WALLET_PLAN_PROPOSAL.free.platformsPerBrand).toBe(180); // why a connection cap is needed
    expect(ENTERPRISE_CAP_PROPOSAL.totalConnectionsIncluded).toBeLessThan(LIVE_TIERS.agency_plus.connectedAccounts);
  });

  it("the seat and brand add on prices equal the live ones (10 USD a month each)", () => {
    expect(ENTERPRISE_CAP_PROPOSAL.extraSeatMonthlyUsd).toBe("10");
    expect(ENTERPRISE_CAP_PROPOSAL.extraBrandMonthlyUsd).toBe("10");
  });
});
