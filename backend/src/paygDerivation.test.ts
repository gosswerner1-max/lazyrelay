import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "./testFakeSupabase.js";

// payg is a DERIVED tier: nobody stores it. An account is payg when its subscription resolves to free, the wallet switch is on and
// accounts.payg_unlocked_at is set. These tests drive the real resolveTier and the rate limiter's cached resolver over the in-memory fake.

const ctl = vi.hoisted(() => ({ failAccounts: false }));

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return {
    supabase: {
      from: (t: string) => {
        if (t === "accounts" && ctl.failAccounts) {
          const b: Record<string, unknown> = {};
          for (const op of ["select", "eq", "maybeSingle"]) b[op] = () => b;
          b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "boom" } }).then(resolve);
          return b;
        }
        return f.makeBuilder(t);
      },
    },
  };
});

const { resolveTier } = await import("./tier.js");
const { resolveCachedTier, TIER_LIMITS } = await import("./http/rateLimit.js");

let n = 0;
let acct = "";
const UNLOCKED = "2026-10-20T08:00:00.000Z";

function setup(opts: { unlocked?: boolean; sub?: { tier: string; status: string } }) {
  acct = `acct-${++n}`;
  tables.accounts = [{ id: acct, payg_unlocked_at: opts.unlocked ? UNLOCKED : null }];
  tables.subscriptions = opts.sub ? [{ account_id: acct, ...opts.sub }] : [];
}

beforeEach(() => {
  ctl.failAccounts = false;
});
afterEach(() => vi.unstubAllEnvs());

async function both() {
  return [await resolveTier(acct), await resolveCachedTier(acct)];
}

describe("payg derivation", () => {
  it("wallet switch off: never payg, even when unlocked", async () => {
    setup({ unlocked: true });
    expect(await both()).toEqual(["free", "free"]);
  });

  it("a switch that is not exactly 'true' is off", async () => {
    vi.stubEnv("WALLET_ENABLED", "1");
    setup({ unlocked: true });
    expect(await both()).toEqual(["free", "free"]);
  });

  it("switch on, unlocked, no subscription row: payg", async () => {
    vi.stubEnv("WALLET_ENABLED", "true");
    setup({ unlocked: true });
    expect(await both()).toEqual(["payg", "payg"]);
  });

  it("switch on but not unlocked: free", async () => {
    vi.stubEnv("WALLET_ENABLED", "true");
    setup({ unlocked: false });
    expect(await both()).toEqual(["free", "free"]);
  });

  it("an active paid subscription wins over the unlock", async () => {
    vi.stubEnv("WALLET_ENABLED", "true");
    setup({ unlocked: true, sub: { tier: "growth", status: "active" } });
    expect(await both()).toEqual(["growth", "growth"]);
  });

  it("a lapsed subscription resolves to free, so an unlocked account is payg", async () => {
    vi.stubEnv("WALLET_ENABLED", "true");
    setup({ unlocked: true, sub: { tier: "growth", status: "past_due" } });
    expect(await both()).toEqual(["payg", "payg"]);
  });

  it("if the account row cannot be read the tier is free, not payg", async () => {
    vi.stubEnv("WALLET_ENABLED", "true");
    setup({ unlocked: true });
    ctl.failAccounts = true;
    expect(await both()).toEqual(["free", "free"]);
  });

  it("payg gets the payg request rate", async () => {
    vi.stubEnv("WALLET_ENABLED", "true");
    setup({ unlocked: true });
    expect(TIER_LIMITS[await resolveCachedTier(acct)]).toBe(300);
  });

  it("flag off makes no accounts read at all (today's behaviour)", async () => {
    setup({ unlocked: true });
    ctl.failAccounts = true;
    expect(await resolveTier(acct)).toBe("free");
  });
});

describe("limit hooks see payg", () => {
  it("brand and account caps follow the derived tier", async () => {
    vi.stubEnv("WALLET_ENABLED", "true");
    setup({ unlocked: true });
    const { getBrandCapacity } = await import("./brandLimits.js");
    const { ACCOUNT_LIMITS } = await import("./accountLimits.js");
    expect(await getBrandCapacity(acct)).toMatchObject({ tier: "payg", baseLimit: 2 });
    expect(ACCOUNT_LIMITS.payg).toBe(20);
  });
});
