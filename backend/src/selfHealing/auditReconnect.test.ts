// An OAuth reconnect that brings back a connection marked needs-reconnect writes one system "recovered" row, only while the
// self-healing mode is on or shadow. Same in-memory fakes as connectReconnectWipe.test.ts; nothing real is touched.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables, vault } from "../testFakeSupabase.js";

const rpcLog = vi.hoisted(() => [] as Array<{ fn: string; args: Record<string, unknown> }>);
vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  return {
    supabase: {
      from: (t: string) => f.makeBuilder(t),
      rpc: (fn: string, args: Record<string, unknown>) => {
        rpcLog.push({ fn, args });
        return fn === "record_system_credential_audit" ? Promise.resolve({ data: true, error: null }) : f.fakeRpc(fn, args);
      },
    },
  };
});
vi.mock("../accountLimits.js", () => ({ checkNewDistinctAccountLimit: vi.fn(async () => null) }));
vi.mock("../http/metaWebhook.js", () => ({ subscribePageToMessaging: vi.fn(async () => {}) }));

const { completeConnect, finalizeConnectSelection } = await import("../platforms/connect.js");

const future = () => new Date(Date.now() + 10 * 60_000).toISOString();
const adapter = {
  platform: "linkedin",
  exchangeCode: vi.fn(async () => ({ accessToken: "NEW-ACCESS", refreshToken: "NEW-REFRESH", expiresAt: "2026-11-29T00:00:00.000Z", platformAccountId: "li-42", displayName: "Jane Doe" })),
};
const registry = new Map([["linkedin", adapter]]) as never;
const audits = () => rpcLog.filter((c) => c.fn === "record_system_credential_audit");

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
  rpcLog.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  tables.oauth_states = [{ id: "st1", account_id: "acc1", platform: "linkedin", expires_at: future(), pkce_verifier: null, pending_options: null, pending_token_vault_id: null }];
  vault.set("old-a", "OLD-ACCESS");
  tables.social_accounts = [{ id: "sa1", account_id: "acc1", platform: "linkedin", platform_account_id: "li-42", access_token_vault_id: "old-a", refresh_token_vault_id: null, disconnected_at: null, tokens_wiped_at: null, needs_reconnect_at: "2026-10-18T00:00:00.000Z" }];
});
afterEach(() => {
  delete process.env.SELF_HEALING_MODE;
  vi.restoreAllMocks();
});

async function reconnect() {
  await completeConnect("st1", "code", registry);
  await finalizeConnectSelection("st1", ["li-42"], "acc1", registry);
}

describe("reconnecting a connection that was marked needs-reconnect", () => {
  it.each(["shadow", "on"])("writes one recovered row in %s mode", async (mode) => {
    process.env.SELF_HEALING_MODE = mode;
    await reconnect();
    expect(tables.social_accounts[0].needs_reconnect_at).toBeNull();
    expect(audits()).toHaveLength(1);
    expect(audits()[0].args).toEqual({ p_account_id: "acc1", p_social_account_id: "sa1", p_platform: "linkedin", p_action: "recovered", p_reason_code: null });
  });

  it("writes nothing while the mode is off, and the reconnect still works", async () => {
    await reconnect();
    expect(tables.social_accounts[0].needs_reconnect_at).toBeNull();
    expect(audits()).toHaveLength(0);
  });

  it("writes nothing for a reconnect of a healthy connection or a brand new one", async () => {
    process.env.SELF_HEALING_MODE = "on";
    tables.social_accounts[0].needs_reconnect_at = null;
    await reconnect();
    expect(audits()).toHaveLength(0);
    tables.social_accounts = [];
    tables.oauth_states = [{ id: "st1", account_id: "acc1", platform: "linkedin", expires_at: future(), pkce_verifier: null, pending_options: null, pending_token_vault_id: null }];
    await reconnect();
    expect(audits()).toHaveLength(0);
  });
});
