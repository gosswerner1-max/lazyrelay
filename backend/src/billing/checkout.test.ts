import { describe, it, expect, vi } from "vitest";
import { createPaddleCheckoutPort, type PaddleHttpClient } from "./checkout.js";
import { SKU } from "../wallet/catalog.js";
import { ACCOUNT_ID, FAKE_PRICES, WALLET_ENV } from "./walletFixtures.testHelper.js";

const API_KEY = "pdl_fake_api_key_for_tests";

function client(response: { status?: number; body: unknown }) {
  const fn = vi.fn().mockResolvedValue({ ok: (response.status ?? 200) < 300, status: response.status ?? 200, text: async () => JSON.stringify(response.body) });
  return fn as unknown as PaddleHttpClient & ReturnType<typeof vi.fn>;
}
const created = { data: { id: "txn_fake_new", checkout: { url: "https://lazyrelay.com/?_ptxn=txn_fake_new" } } };

function port(http: PaddleHttpClient, env: Record<string, string | undefined> = { ...WALLET_ENV, PADDLE_ENVIRONMENT: "production" }) {
  return createPaddleCheckoutPort({ apiKey: API_KEY, http, env });
}

describe("createCheckout", () => {
  it("creates a Paddle transaction on the price id with custom data {account_id, sku} and returns the checkout url", async () => {
    const http = client({ body: created });
    const out = await port(http).createCheckout(ACCOUNT_ID, SKU.starterPack);
    expect(out).toEqual({ checkoutUrl: "https://lazyrelay.com/?_ptxn=txn_fake_new", transactionId: "txn_fake_new" });
    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0];
    expect(url).toBe("https://api.paddle.com/transactions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(init.body)).toEqual({
      items: [{ price_id: FAKE_PRICES.starterPack, quantity: 1 }],
      custom_data: { account_id: ACCOUNT_ID, sku: SKU.starterPack },
      checkout: { url: "https://lazyrelay.com" },
    });
  });

  it("uses the sandbox host unless PADDLE_ENVIRONMENT is production", async () => {
    const http = client({ body: created });
    await port(http, { ...WALLET_ENV }).createCheckout(ACCOUNT_ID, SKU.growthPlan);
    expect(http.mock.calls[0][0]).toBe("https://sandbox-api.paddle.com/transactions");
    expect(JSON.parse(http.mock.calls[0][1].body).items[0].price_id).toBe(FAKE_PRICES.growthPlan);
  });

  it("refuses an unknown sku before any request", async () => {
    const http = client({ body: created });
    await expect(port(http).createCheckout(ACCOUNT_ID, "lazyrelay-starter")).rejects.toThrow(/unknown sku/);
    expect(http).not.toHaveBeenCalled();
  });

  it("refuses an account id that is not a uuid before any request", async () => {
    const http = client({ body: created });
    await expect(port(http).createCheckout("not-an-id", SKU.starterPack)).rejects.toThrow(/account id/);
    expect(http).not.toHaveBeenCalled();
  });

  it("names the missing env var when the price id is not configured, and calls nothing", async () => {
    const http = client({ body: created });
    await expect(port(http, { PADDLE_ENVIRONMENT: "production" }).createCheckout(ACCOUNT_ID, SKU.proPlan)).rejects.toThrow(/PADDLE_PRICE_ID_PRO_PLAN/);
    expect(http).not.toHaveBeenCalled();
  });

  it("a Paddle error is thrown raw (status and body), never turned into a success, and never carries the api key", async () => {
    const http = client({ status: 400, body: { error: { code: "invalid_field", detail: "price is archived" } } });
    const err = await port(http).createCheckout(ACCOUNT_ID, SKU.starterPack).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("400");
    expect((err as Error).message).toContain("price is archived");
    expect((err as Error).message).not.toContain(API_KEY);
  });

  it("a response with no checkout url is an error", async () => {
    const http = client({ body: { data: { id: "txn_fake_new", checkout: null } } });
    await expect(port(http).createCheckout(ACCOUNT_ID, SKU.starterPack)).rejects.toThrow(/checkout url/);
  });

  it("a network failure is thrown as is", async () => {
    const http = vi.fn().mockRejectedValue(new Error("socket hang up")) as unknown as PaddleHttpClient;
    await expect(port(http).createCheckout(ACCOUNT_ID, SKU.starterPack)).rejects.toThrow(/socket hang up/);
  });

  it("a missing api key fails at construction", () => {
    expect(() => createPaddleCheckoutPort({ apiKey: "", http: client({ body: created }), env: WALLET_ENV })).toThrow(/MOR_API_KEY/);
  });
});
