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

describe("createCheckout with a known account email", () => {
  const EMAIL = "customer@example.com";
  const found = { data: [{ id: "ctm_found" }] };
  const none = { data: [] };
  const makeCustomer = { data: { id: "ctm_new" } };
  /** A fake http that answers by method and path. */
  function routed(answers: { lookup?: { status?: number; body: unknown }; create?: { status?: number; body: unknown } }) {
    const answer = (r: { status?: number; body: unknown }) => ({ ok: (r.status ?? 200) < 300, status: r.status ?? 200, text: async () => JSON.stringify(r.body) });
    return vi.fn(async (url: string, init: { method: string }) => {
      if (url.includes("/customers?")) return answer(answers.lookup ?? { body: none });
      if (url.endsWith("/customers")) return answer(answers.create ?? { body: makeCustomer });
      return answer({ body: created });
    }) as unknown as PaddleHttpClient & ReturnType<typeof vi.fn>;
  }
  function withEmail(http: PaddleHttpClient, email: string | null | (() => Promise<string | null>) = EMAIL) {
    const emailForAccount = typeof email === "function" ? email : async () => email;
    return createPaddleCheckoutPort({ apiKey: API_KEY, http, env: { ...WALLET_ENV, PADDLE_ENVIRONMENT: "production" }, emailForAccount });
  }
  const bodyOfTransaction = (http: ReturnType<typeof vi.fn>) => JSON.parse(http.mock.calls.find((c) => String(c[0]).endsWith("/transactions"))![1].body);

  it("reuses the Paddle customer that already has this email and sends its id on the transaction", async () => {
    const http = routed({ lookup: { body: found } });
    await withEmail(http).createCheckout(ACCOUNT_ID, SKU.starterPack);
    const lookupCall = http.mock.calls[0];
    expect(lookupCall[0]).toBe("https://api.paddle.com/customers?email=customer%40example.com");
    expect(lookupCall[1].method).toBe("GET");
    expect(http.mock.calls.some((c) => c[1].method === "POST" && String(c[0]).endsWith("/customers"))).toBe(false);
    expect(bodyOfTransaction(http).customer_id).toBe("ctm_found");
  });

  it("creates the customer when none has this email", async () => {
    const http = routed({ lookup: { body: none } });
    await withEmail(http).createCheckout(ACCOUNT_ID, SKU.starterPack);
    const createCall = http.mock.calls.find((c) => c[1].method === "POST" && String(c[0]).endsWith("/customers"))!;
    expect(JSON.parse(createCall[1].body)).toEqual({ email: EMAIL });
    expect(bodyOfTransaction(http).customer_id).toBe("ctm_new");
  });

  it("sends no customer and makes no customer call when the email is not known", async () => {
    const http = routed({});
    await withEmail(http, null).createCheckout(ACCOUNT_ID, SKU.starterPack);
    expect(http).toHaveBeenCalledTimes(1);
    expect(bodyOfTransaction(http)).not.toHaveProperty("customer_id");
  });

  it("a failed email lookup is thrown raw and no transaction is created", async () => {
    const http = routed({});
    await expect(withEmail(http, async () => { throw new Error("auth user read failed: boom"); }).createCheckout(ACCOUNT_ID, SKU.starterPack)).rejects.toThrow(/auth user read failed: boom/);
    expect(http).not.toHaveBeenCalled();
  });

  it("a failed customer lookup or create is thrown raw (status and body), no transaction, no api key in the message", async () => {
    const lookupFail = routed({ lookup: { status: 403, body: { error: { detail: "forbidden thing" } } } });
    const e1 = await withEmail(lookupFail).createCheckout(ACCOUNT_ID, SKU.starterPack).catch((e: Error) => e);
    expect((e1 as Error).message).toMatch(/403/);
    expect((e1 as Error).message).toContain("forbidden thing");
    expect((e1 as Error).message).not.toContain(API_KEY);
    expect(lookupFail.mock.calls.every((c) => !String(c[0]).endsWith("/transactions"))).toBe(true);

    const createFail = routed({ lookup: { body: none }, create: { status: 400, body: { error: { detail: "invalid email" } } } });
    await expect(withEmail(createFail).createCheckout(ACCOUNT_ID, SKU.starterPack)).rejects.toThrow(/400.*invalid email/s);
    expect(createFail.mock.calls.every((c) => !String(c[0]).endsWith("/transactions"))).toBe(true);
  });

  it("a customer answer without an id is an error", async () => {
    const http = routed({ lookup: { body: none }, create: { body: { data: {} } } });
    await expect(withEmail(http).createCheckout(ACCOUNT_ID, SKU.starterPack)).rejects.toThrow(/customer id/);
  });
});

describe("createCheckout with a partner code (affiliate attribution)", () => {
  it("puts partnerCode into the transaction custom data next to account_id and sku", async () => {
    const http = client({ body: created });
    await port(http).createCheckout(ACCOUNT_ID, SKU.starterPack, { partnerCode: "sarah" });
    expect(JSON.parse(http.mock.calls[0][1].body).custom_data).toEqual({ account_id: ACCOUNT_ID, sku: SKU.starterPack, partnerCode: "sarah" });
  });

  it("leaves custom data exactly as before when there is no partner code", async () => {
    const http = client({ body: created });
    await port(http).createCheckout(ACCOUNT_ID, SKU.starterPack, {});
    expect(JSON.parse(http.mock.calls[0][1].body).custom_data).toEqual({ account_id: ACCOUNT_ID, sku: SKU.starterPack });
  });
});

describe("createCheckout with the partner discount (10% off the first payment of Growth or Pro)", () => {
  const withDiscount = { ...WALLET_ENV, PADDLE_ENVIRONMENT: "production", PADDLE_PARTNER_DISCOUNT_ID: "dsc_fake_partner" };
  const body = (http: ReturnType<typeof client>) => JSON.parse(http.mock.calls[0][1].body);

  it.each([[SKU.growthPlan], [SKU.proPlan]])("%s with a partner code gets the one shared discount id and reports it", async (sku) => {
    const http = client({ body: created });
    const out = await port(http, withDiscount).createCheckout(ACCOUNT_ID, sku, { partnerCode: "sarah" });
    expect(body(http).discount_id).toBe("dsc_fake_partner");
    expect(out).toMatchObject({ transactionId: "txn_fake_new", discountApplied: true });
  });

  it.each([[SKU.starterPack], [SKU.growthPack], [SKU.proTopUp]])("the pack %s never gets a discount", async (sku) => {
    const http = client({ body: created });
    const out = await port(http, withDiscount).createCheckout(ACCOUNT_ID, sku, { partnerCode: "sarah" });
    expect(body(http).discount_id).toBeUndefined();
    expect((out as { discountApplied?: boolean }).discountApplied).toBeUndefined();
  });

  it("a plan with no partner code gets no discount", async () => {
    const http = client({ body: created });
    await port(http, withDiscount).createCheckout(ACCOUNT_ID, SKU.growthPlan);
    expect(body(http).discount_id).toBeUndefined();
  });

  it("with PADDLE_PARTNER_DISCOUNT_ID unset the checkout still works, with the code in custom data and no discount", async () => {
    const http = client({ body: created });
    const out = await port(http).createCheckout(ACCOUNT_ID, SKU.growthPlan, { partnerCode: "sarah" });
    expect(body(http).discount_id).toBeUndefined();
    expect(body(http).custom_data.partnerCode).toBe("sarah");
    expect((out as { discountApplied?: boolean }).discountApplied).toBeUndefined();
  });
});

describe("the customer lookup (a GET) carries no body, like Node's fetch demands", () => {
  it("Node's own fetch refuses a GET with a body (this is why the lookup used to fail with a 503)", async () => {
    await expect(fetch("http://127.0.0.1:9/x", { method: "GET", body: "" })).rejects.toThrow(/cannot have body/i);
  });

  it("createCheckout for a buyer with a known email never sends a body on the GET", async () => {
    const seen: Array<{ method: string; body: unknown }> = [];
    const http = vi.fn(async (url: string, init: { method: string; body?: string }) => {
      seen.push({ method: init.method, body: init.body });
      if ((init.method === "GET" || init.method === "HEAD") && init.body !== undefined) throw new TypeError("Request with GET/HEAD method cannot have body.");
      const data = url.includes("/customers?") ? { data: [{ id: "ctm_1" }] } : created;
      return { ok: true, status: 200, text: async () => JSON.stringify(data) };
    }) as unknown as PaddleHttpClient;
    const p = createPaddleCheckoutPort({ apiKey: API_KEY, http, env: { ...WALLET_ENV, PADDLE_ENVIRONMENT: "production" }, emailForAccount: async () => "buyer@example.org" });
    const out = await p.createCheckout(ACCOUNT_ID, SKU.starterPack);
    expect(out).toMatchObject({ transactionId: "txn_fake_new" });
    expect(seen[0]).toEqual({ method: "GET", body: undefined });
  });
});
