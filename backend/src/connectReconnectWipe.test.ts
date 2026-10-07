// Reconnecting an account stores the NEW login in a new Vault entry and re-points the row at it. The login it replaced
// must be overwritten, otherwise every reconnect leaves a live token behind in Vault for good.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables, vault } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, args: Record<string, unknown>) => f.fakeRpc(fn, args) } };
});
vi.mock("./accountLimits.js", () => ({ checkNewDistinctAccountLimit: vi.fn(async () => null) }));
vi.mock("./http/metaWebhook.js", () => ({ subscribePageToMessaging: vi.fn(async () => {}) }));

const { completeConnect, finalizeConnectSelection } = await import("./platforms/connect.js");

const future = () => new Date(Date.now() + 10 * 60_000).toISOString();
const adapter = {
  platform: "linkedin",
  exchangeCode: vi.fn(async () => ({
    accessToken: "NEW-ACCESS",
    refreshToken: "NEW-REFRESH",
    expiresAt: "2026-11-29T00:00:00.000Z",
    platformAccountId: "li-42",
    displayName: "Luzaan Jacobs",
  })),
};
const registry = new Map([["linkedin", adapter]]) as never;

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  tables.oauth_states = [{ id: "st1", account_id: "acc1", platform: "linkedin", expires_at: future(), pkce_verifier: null, pending_options: null, pending_token_vault_id: null }];
});

describe("reconnecting an account that already exists", () => {
  it("overwrites the login it replaces, stores the new one, and clears the disconnected and wiped marks", async () => {
    vault.set("old-a", "OLD-ACCESS");
    vault.set("old-r", "OLD-REFRESH");
    tables.social_accounts = [
      {
        id: "sa1", account_id: "acc1", platform: "linkedin", platform_account_id: "li-42",
        access_token_vault_id: "old-a", refresh_token_vault_id: "old-r",
        disconnected_at: "2026-10-01T00:00:00.000Z", tokens_wiped_at: "2026-10-01T00:00:01.000Z",
      },
    ];

    await completeConnect("st1", "code", registry);
    await finalizeConnectSelection("st1", ["li-42"], "acc1", registry);

    expect(tables.social_accounts).toHaveLength(1);
    const row = tables.social_accounts[0];
    expect(row.disconnected_at).toBeNull();
    expect(row.tokens_wiped_at).toBeNull();
    expect(row.access_token_vault_id).not.toBe("old-a");
    expect(vault.get(row.access_token_vault_id as string)).toBe("NEW-ACCESS");
    expect(vault.get(row.refresh_token_vault_id as string)).toBe("NEW-REFRESH");
    // the replaced login is gone from Vault
    expect(vault.get("old-a")).toBe("revoked");
    expect(vault.get("old-r")).toBe("revoked");
  });

  it("a brand new account has nothing to wipe", async () => {
    tables.social_accounts = [];
    await completeConnect("st1", "code", registry);
    await finalizeConnectSelection("st1", ["li-42"], "acc1", registry);
    expect(tables.social_accounts).toHaveLength(1);
    expect([...vault.values()]).not.toContain("revoked");
  });
});
