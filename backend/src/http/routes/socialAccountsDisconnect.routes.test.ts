// Disconnecting an account must destroy LazyRelay's copy of its login (the Data Deletion page promises it), must not
// touch anybody else's account, and must still succeed when the wipe itself fails (the sweep retries it).

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables, vault } from "../../testFakeSupabase.js";

const rpcFails = vi.hoisted(() => ({ on: false }));
vi.mock("../auth.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return {
    requireAuth: (req: any, _res: any, next: any) => {
      req.accountId = "acc1";
      req.authMethod = "jwt";
      req.db = { from: (t: string) => f.makeBuilder(t) };
      next();
    },
  };
});
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n(), publicRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return {
    supabase: {
      from: (t: string) => f.makeBuilder(t),
      rpc: (fn: string, args: Record<string, unknown>) =>
        rpcFails.on ? Promise.resolve({ data: null, error: { message: "vault unavailable" } }) : f.fakeRpc(fn, args),
    },
  };
});
vi.mock("../../accountLimits.js", () => ({ checkAccountLimit: async () => null }));
vi.mock("../../scheduler.js", () => ({ getAccessToken: async () => "t" }));
vi.mock("../../platforms/connect.js", () => ({
  startConnect: async () => ({}),
  getPendingSelection: async () => ({}),
  finalizeConnectSelection: async () => ({}),
  cancelConnectSelection: async () => ({}),
  completeConnect: async () => ({}),
}));

const { buildSocialAccountsRouter } = await import("./socialAccounts.routes.js");

const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildSocialAccountsRouter(new Map() as never));
  return a;
};

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
  rpcFails.on = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vault.set("mine-a", "MY-ACCESS-TOKEN");
  vault.set("mine-r", "MY-REFRESH-TOKEN");
  vault.set("theirs-a", "THEIR-ACCESS-TOKEN");
  vault.set("other-a", "OTHER-ACCOUNT-TOKEN");
  tables.social_accounts = [
    { id: "sa1", account_id: "acc1", platform: "linkedin", access_token_vault_id: "mine-a", refresh_token_vault_id: "mine-r", disconnected_at: null, tokens_wiped_at: null },
    { id: "sa2", account_id: "acc1", platform: "mastodon", access_token_vault_id: "theirs-a", refresh_token_vault_id: null, disconnected_at: null, tokens_wiped_at: null },
    { id: "sa3", account_id: "acc2", platform: "linkedin", access_token_vault_id: "other-a", refresh_token_vault_id: null, disconnected_at: null, tokens_wiped_at: null },
  ];
});

describe("DELETE /social-accounts/:id", () => {
  it("marks the account disconnected AND overwrites its stored login", async () => {
    const res = await request(app()).delete("/social-accounts/sa1");
    expect(res.status).toBe(204);
    expect(tables.social_accounts[0].disconnected_at).toBeTruthy();
    expect(tables.social_accounts[0].tokens_wiped_at).toBeTruthy();
    expect(vault.get("mine-a")).toBe("revoked");
    expect(vault.get("mine-r")).toBe("revoked");
    expect([...vault.values()].some((v) => v.includes("MY-"))).toBe(false);
  });

  it("leaves every other connection alone, including another LazyRelay account's", async () => {
    await request(app()).delete("/social-accounts/sa1");
    expect(vault.get("theirs-a")).toBe("THEIR-ACCESS-TOKEN");
    expect(vault.get("other-a")).toBe("OTHER-ACCOUNT-TOKEN");
    expect(tables.social_accounts[1].disconnected_at).toBeNull();
  });

  it("cannot be used to wipe an account that belongs to someone else", async () => {
    const res = await request(app()).delete("/social-accounts/sa3");
    expect(res.status).toBe(404);
    expect(vault.get("other-a")).toBe("OTHER-ACCOUNT-TOKEN");
    expect(tables.social_accounts[2].disconnected_at).toBeNull();
  });

  it("still disconnects when the wipe fails, and leaves the account marked for the sweep to retry", async () => {
    rpcFails.on = true;
    const res = await request(app()).delete("/social-accounts/sa1");
    expect(res.status).toBe(204);
    expect(tables.social_accounts[0].disconnected_at).toBeTruthy();
    expect(tables.social_accounts[0].tokens_wiped_at).toBeNull(); // the sweep finds it by this
    expect(vault.get("mine-a")).toBe("MY-ACCESS-TOKEN");
  });

  it("disconnecting twice is a plain 404, not a second wipe", async () => {
    await request(app()).delete("/social-accounts/sa1");
    const again = await request(app()).delete("/social-accounts/sa1");
    expect(again.status).toBe(404);
  });
});
