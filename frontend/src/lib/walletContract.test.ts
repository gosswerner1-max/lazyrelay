// The server's real answers (written by backend/src/http/routes/wallet.contract.test.ts from the REAL route, service and Paddle port)
// fed into the REAL client code. Nothing here is a hand built shape. If the server and the website ever disagree again, this fails.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("./supabase", () => ({ supabase: {} })); // the real client refuses to start without its address

import { getBalance } from "./walletApi";
import { startCheckout } from "./walletCheckout";

const contract = (name: string): unknown => JSON.parse(readFileSync(resolve(__dirname, "../../../contracts", name), "utf8"));

describe("GET /wallet/balance as the server really answers it", () => {
  it("is read by getBalance as a usable wallet (the buy panel no longer says not available)", async () => {
    const result = await getBalance(async () => contract("wallet-balance.json"));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.wallet).toMatchObject({ exempt: false, balance: 1830, held: 5, paused: false });
    expect(result.wallet.lots.map((l) => l.kind)).toEqual(["subscription", "pack", "signup"]);
    expect(result.wallet.nextExpiry).toEqual({ at: "2026-11-10T12:00:00.000Z", credits: 1200 });
    expect(result.wallet.plan.caps).toEqual({ accounts: 1000, brands: null, queued: null });
    expect(result.wallet.prices).toEqual({ post_publish: 1, competitor_teardown: 10 });
  });
});

describe("POST /wallet/checkout-intent as the server really answers it", () => {
  it("is read by startCheckout as a started purchase", async () => {
    const fetcher = vi.fn(async () => contract("wallet-checkout-intent.json"));
    const result = await startCheckout("lazyrelay-growth-plan", fetcher);
    expect(result).toEqual({
      ok: true,
      transactionId: "txn_fake_new",
      checkoutUrl: "https://lazyrelay.com/?_ptxn=txn_fake_new",
      sku: "lazyrelay-growth-plan",
      partner: "none",
      discount: false,
    });
  });
});
