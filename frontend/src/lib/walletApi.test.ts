import { describe, expect, it, vi } from "vitest";
import { sampleBalance, sampleCatalog } from "./walletFixtures";

vi.mock("./supabase", () => ({ supabase: {} })); // the real client refuses to start without its address

import { getBalance, getCatalog } from "./walletApi";

type Failure = Error & { status?: number; code?: string };
const failing = (status: number, message = "raw server words") => async () => {
  throw Object.assign(new Error(message), { status });
};
const answering = (body: unknown) => async () => body;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

describe("getBalance", () => {
  it("asks /wallet/balance and returns the checked wallet", async () => {
    const fetcher = vi.fn(async () => sampleBalance());
    const result = await getBalance(fetcher);
    expect(fetcher).toHaveBeenCalledWith("/wallet/balance");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.wallet.balance).toBe(1830);
      expect(result.wallet.lots).toHaveLength(4);
      expect(result.wallet.plan.caps.brands).toBeNull();
    }
  });

  it("accepts a null wallet plan and a null next expiry", async () => {
    const body = clone(sampleBalance());
    (body.plan as { walletPlan: unknown }).walletPlan = null;
    (body as { nextExpiry: unknown }).nextExpiry = null;
    expect((await getBalance(answering(body))).kind).toBe("ok");
  });

  it("treats a 404 (billing switched off on the server) as unavailable, not as an error", async () => {
    expect(await getBalance(failing(404))).toEqual({ kind: "unavailable" });
  });

  it.each([null, undefined, 5, "text", [], true])("treats %j as unavailable", async (body) => {
    expect(await getBalance(answering(body))).toEqual({ kind: "unavailable" });
  });

  const breakers: [string, (b: any) => void][] = [
    ["exempt missing", (b) => delete b.exempt],
    ["exempt not boolean", (b) => (b.exempt = "no")],
    ["balance fractional", (b) => (b.balance = 1.5)],
    ["balance negative", (b) => (b.balance = -1)],
    ["balance a string", (b) => (b.balance = "9")],
    ["balance not finite", (b) => (b.balance = Number.POSITIVE_INFINITY)],
    ["held fractional", (b) => (b.held = 0.5)],
    ["held missing", (b) => delete b.held],
    ["lots not an array", (b) => (b.lots = {})],
    ["lot is not an object", (b) => (b.lots[0] = 7)],
    ["lot kind unknown", (b) => (b.lots[0].kind = "gift")],
    ["lot remaining fractional", (b) => (b.lots[0].remaining = 0.2)],
    ["lot remaining negative", (b) => (b.lots[0].remaining = -3)],
    ["lot expiresAt a number", (b) => (b.lots[0].expiresAt = 5)],
    ["lot expiresAt not a date", (b) => (b.lots[0].expiresAt = "soon")],
    ["lot expiresAt missing", (b) => delete b.lots[0].expiresAt],
    ["lot boundPlan unknown", (b) => (b.lots[1].boundPlan = "growth")],
    ["lot autoRenew a string", (b) => (b.lots[0].autoRenew = "yes")],
    ["lot planName a number", (b) => (b.lots[0].planName = 4)],
    ["nextExpiry malformed", (b) => (b.nextExpiry = { at: 3, credits: 1 })],
    ["nextExpiry credits fractional", (b) => (b.nextExpiry = { at: "2026-11-10T12:00:00Z", credits: 0.5 })],
    ["nextExpiry missing", (b) => delete b.nextExpiry],
    ["paused not boolean", (b) => (b.paused = 1)],
    ["plan missing", (b) => delete b.plan],
    ["plan tier not a string", (b) => (b.plan.tier = 3)],
    ["walletPlan unknown", (b) => (b.plan.walletPlan = "gold")],
    ["caps missing", (b) => delete b.plan.caps],
    ["caps accounts a string", (b) => (b.plan.caps.accounts = "30")],
    ["caps brands undefined", (b) => delete b.plan.caps.brands],
    ["caps brands fractional", (b) => (b.plan.caps.brands = 2.5)],
    ["caps queued a string", (b) => (b.plan.caps.queued = "many")],
    ["prices missing", (b) => delete b.prices],
    ["post_publish a string", (b) => (b.prices.post_publish = "1")],
    ["competitor_teardown missing", (b) => delete b.prices.competitor_teardown],
  ];
  it.each(breakers)("treats a wrong shape as unavailable: %s", async (_name, breakIt) => {
    const body = clone(sampleBalance());
    breakIt(body);
    expect(await getBalance(answering(body))).toEqual({ kind: "unavailable" });
  });

  it("turns a server failure into friendly words, keeps the raw error for the caller, and never shows the raw text", async () => {
    const result = await getBalance(failing(500, "ECONNRESET at db-3.internal"));
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toBe("We could not load your credits just now. Please try again.");
      expect(result.message).not.toContain("ECONNRESET");
      expect((result.cause as Failure).status).toBe(500);
    }
  });

  it("asks for a fresh sign-in on a 401 or when there is no session", async () => {
    const noSession = async () => {
      throw new Error("Not signed in");
    };
    for (const fetcher of [failing(401), noSession]) {
      const result = await getBalance(fetcher);
      expect(result).toMatchObject({ kind: "error", message: "Please sign in again to see your credits." });
    }
  });
});

describe("getCatalog", () => {
  it("asks /wallet/catalog and returns the checked items", async () => {
    const fetcher = vi.fn(async () => sampleCatalog());
    const result = await getCatalog(fetcher);
    expect(fetcher).toHaveBeenCalledWith("/wallet/catalog");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.items.map((i) => i.sku)).toEqual(["pack_small", "pro_monthly", "pro_topup"]);
  });

  it("accepts an empty list", async () => {
    expect(await getCatalog(answering({ items: [] }))).toEqual({ kind: "ok", items: [] });
  });

  it("treats a 404 as unavailable", async () => {
    expect(await getCatalog(failing(404))).toEqual({ kind: "unavailable" });
  });

  it.each([null, 3, "x", [], {}, { items: "no" }])("treats %j as unavailable", async (body) => {
    expect(await getCatalog(answering(body))).toEqual({ kind: "unavailable" });
  });

  const breakers: [string, (i: any) => void][] = [
    ["sku empty", (i) => (i.sku = "")],
    ["sku missing", (i) => delete i.sku],
    ["name not a string", (i) => (i.name = 3)],
    ["kind unknown", (i) => (i.kind = "bundle")],
    ["priceCents fractional", (i) => (i.priceCents = 9.5)],
    ["priceCents negative", (i) => (i.priceCents = -1)],
    ["credits a string", (i) => (i.credits = "300")],
    ["expires not boolean", (i) => (i.expires = "no")],
    ["interval unknown", (i) => (i.interval = "year")],
    ["requiresPlan a number", (i) => (i.requiresPlan = 1)],
    ["requiresPlan missing", (i) => delete i.requiresPlan],
    ["purchasable not boolean", (i) => (i.purchasable = 1)],
    ["reason unknown", (i) => (i.reason = "because")],
    ["reason missing", (i) => delete i.reason],
  ];
  it.each(breakers)("treats one bad item as unavailable for the whole list: %s", async (_name, breakIt) => {
    const body = clone(sampleCatalog());
    breakIt(body.items[0]);
    expect(await getCatalog(answering(body))).toEqual({ kind: "unavailable" });
  });

  it("turns a server failure into friendly words", async () => {
    const result = await getCatalog(failing(503, "upstream timeout"));
    expect(result).toMatchObject({ kind: "error", message: "We could not load the credit options just now. Please try again." });
  });
});
