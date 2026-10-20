// The old monthly free-post rule (10 posts per connected account per month) must not apply to the derived payg plan: a payg account pays
// per post with credits instead. A plain free account keeps the rule, and with the wallet switch off nothing changes at all.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t) } };
});

const { checkFreeTierPostLimit, FREE_TIER_MONTHLY_POSTS_PER_ACCOUNT } = await import("./postCreation.js");

function fill(account: string, social: string) {
  tables.scheduled_posts = Array.from({ length: FREE_TIER_MONTHLY_POSTS_PER_ACCOUNT + 2 }, (_, i) => ({ id: `m${i}`, account_id: account, social_account_id: social, created_at: new Date().toISOString() }));
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.subscriptions = [];
  vi.stubEnv("WALLET_ENABLED", "true");
  vi.stubEnv("WALLET_MODE", "on");
});
afterEach(() => vi.unstubAllEnvs());

describe("checkFreeTierPostLimit and the derived payg plan", () => {
  it("a payg account (free subscription, payg unlocked) is not stopped by the monthly rule", async () => {
    tables.accounts = [{ id: "payg-acct", payg_unlocked_at: "2026-10-20T08:00:00.000Z" }];
    fill("payg-acct", "sa-payg");
    expect(await checkFreeTierPostLimit("payg-acct", "sa-payg")).toBeNull();
  });

  it("a plain free account still is", async () => {
    tables.accounts = [{ id: "free-acct", payg_unlocked_at: null }];
    fill("free-acct", "sa-free");
    expect(await checkFreeTierPostLimit("free-acct", "sa-free")).toMatchObject({ status: 403 });
  });

  it("with the wallet switch off, a payg flag changes nothing (today's behaviour)", async () => {
    vi.stubEnv("WALLET_ENABLED", "false");
    tables.accounts = [{ id: "payg-acct", payg_unlocked_at: "2026-10-20T08:00:00.000Z" }];
    fill("payg-acct", "sa-payg");
    expect(await checkFreeTierPostLimit("payg-acct", "sa-payg")).toMatchObject({ status: 403 });
  });
});
