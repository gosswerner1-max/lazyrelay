// The Free plan queue cap: a non-legacy free account holds at most 10 queued posts (pending or needs_approval). Behind the wallet switch only.
// supabase is an in-memory fake, nothing real is touched.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t) } };
});
vi.mock("./googleCalendar/outboundSync.js", () => ({ syncPostToCalendar: vi.fn(async () => {}) }));
vi.mock("./googleSheets/outboundSync.js", () => ({ syncAccountSheet: vi.fn(async () => {}) }));
vi.mock("./pinterestWarmup.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./pinterestWarmup.js")>();
  return { ...real, resolvePostLimitAt: async (_id: string, platform: string, at: Date) => real.effectiveLimitAt(platform, { connectedAt: null, confirmed: true }, at) };
});

const { checkQueueCap, enforceQueueCap, FREE_QUEUE_CAP, FREE_QUEUE_CAP_MESSAGE } = await import("./queueCap.js");
const { scheduleOnePost } = await import("./postCreation.js");

let n = 0;
function queue(account: string, count: number, status = "pending") {
  for (let i = 0; i < count; i += 1) tables.scheduled_posts.push({ id: `q${++n}`, account_id: account, social_account_id: `sa-q${n}`, status });
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.scheduled_posts = [];
  tables.subscriptions = [];
  tables.accounts = [];
  tables.wallet_legacy_accounts = [];
  tables.social_accounts = [{ id: "mine", account_id: "me", platform: "bluesky" }];
  vi.stubEnv("WALLET_ENABLED", "true");
  vi.stubEnv("WALLET_MODE", "on");
});
afterEach(() => vi.unstubAllEnvs());

describe("checkQueueCap", () => {
  it("says it in plain words, with the cap of 10", () => {
    expect(FREE_QUEUE_CAP).toBe(10);
    expect(FREE_QUEUE_CAP_MESSAGE).toBe("Your free plan holds up to 10 queued posts. Publish or remove one, or add credits.");
  });

  it("allows up to 10 queued posts and refuses the 11th", async () => {
    queue("me", 9);
    expect(await checkQueueCap("me", "free", false)).toBeNull();
    queue("me", 1);
    expect(await checkQueueCap("me", "free", false)).toEqual({ status: 403, body: { error: FREE_QUEUE_CAP_MESSAGE } });
  });

  it("counts pending and needs_approval, and nothing else", async () => {
    queue("me", 5, "pending");
    queue("me", 5, "needs_approval");
    for (const s of ["draft", "posting", "posted", "failed"]) queue("me", 3, s);
    expect(await checkQueueCap("me", "free", false)).not.toBeNull();
    tables.scheduled_posts = tables.scheduled_posts.filter((p) => p.status !== "needs_approval");
    expect(await checkQueueCap("me", "free", false)).toBeNull();
  });

  it("counts only this account's posts", async () => {
    queue("someone-else", 30);
    expect(await checkQueueCap("me", "free", false)).toBeNull();
  });

  it("never applies to a legacy account", async () => {
    queue("me", 50);
    expect(await checkQueueCap("me", "free", true)).toBeNull();
  });

  it("never applies to any tier other than free", async () => {
    queue("me", 50);
    for (const t of ["payg", "growth", "lazy_pro", "starter", "pro", "business", "agency", "agency_plus"] as const) {
      expect(await checkQueueCap("me", t, false), t).toBeNull();
    }
  });

  it("shadow mode (switch on, mode not 'on') never refuses", async () => {
    queue("me", 50);
    vi.stubEnv("WALLET_MODE", "shadow");
    expect(await checkQueueCap("me", "free", false)).toBeNull();
    vi.stubEnv("WALLET_MODE", "");
    expect(await checkQueueCap("me", "free", false)).toBeNull();
    expect(await enforceQueueCap("me")).toBeNull();
  });

  it("does nothing when the wallet switch is off (today's behaviour)", async () => {
    vi.stubEnv("WALLET_ENABLED", "false");
    queue("me", 50);
    expect(await checkQueueCap("me", "free", false)).toBeNull();
  });
});

describe("enforceQueueCap (resolves the tier and the legacy flag)", () => {
  it("refuses a free account at 10, allows a legacy one and a paid one", async () => {
    queue("me", 10);
    queue("old-timer", 10);
    tables.wallet_legacy_accounts = [{ account_id: "old-timer" }];
    expect(await enforceQueueCap("me")).not.toBeNull();
    expect(await enforceQueueCap("old-timer")).toBeNull();
  });

  it("an active paid subscription is not capped", async () => {
    queue("paid", 10);
    tables.subscriptions = [{ account_id: "paid", tier: "growth", status: "active" }];
    expect(await enforceQueueCap("paid")).toBeNull();
  });

  it("switch off: no reads at all, so nothing can change today's behaviour", async () => {
    vi.stubEnv("WALLET_ENABLED", "false");
    queue("me", 10);
    delete (tables as Record<string, unknown>).wallet_legacy_accounts;
    expect(await enforceQueueCap("me")).toBeNull();
    expect(tables.wallet_legacy_accounts).toBeUndefined();
  });
});

describe("scheduleOnePost applies the cap", () => {
  const input = () => ({ socialAccountId: "mine", content: "hello", scheduledFor: new Date(Date.now() + 86_400_000).toISOString() });

  it("refuses the 11th queued post on a non-legacy free account", async () => {
    queue("me", 10);
    const result = await scheduleOnePost("me", input());
    expect(result).toEqual({ status: 403, body: { error: FREE_QUEUE_CAP_MESSAGE } });
    expect(tables.scheduled_posts.filter((p) => p.content === "hello")).toHaveLength(0);
  });

  it("creates it when the account is legacy", async () => {
    queue("legacy-me", 10);
    tables.wallet_legacy_accounts = [{ account_id: "legacy-me" }];
    tables.social_accounts.push({ id: "mine-legacy", account_id: "legacy-me", platform: "bluesky" });
    const result = await scheduleOnePost("legacy-me", { ...input(), socialAccountId: "mine-legacy" });
    expect(result.status).toBe(201);
  });

  it("switch off: the 11th is created exactly as before", async () => {
    vi.stubEnv("WALLET_ENABLED", "false");
    queue("me", 10);
    expect((await scheduleOnePost("me", input())).status).toBe(201);
  });
});
