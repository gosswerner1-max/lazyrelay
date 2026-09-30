// Behavior tests for the connect confirmation step: every OAuth connect now
// holds the fresh login and asks the customer to confirm the account before
// anything is saved. supabase, Vault and the platform are all in-memory fakes.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables, vault } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, args: Record<string, unknown>) => f.fakeRpc(fn, args) } };
});
vi.mock("./accountLimits.js", () => ({ checkNewDistinctAccountLimit: vi.fn(async () => null) }));
vi.mock("./http/metaWebhook.js", () => ({ subscribePageToMessaging: vi.fn(async () => {}) }));

const { completeConnect, getPendingSelection, finalizeConnectSelection, cancelConnectSelection } = await import("./platforms/connect.js");

const future = () => new Date(Date.now() + 10 * 60_000).toISOString();

function seedState(over: Record<string, unknown> = {}) {
  tables.oauth_states = [{ id: "st1", account_id: "acc1", platform: "linkedin", expires_at: future(), pkce_verifier: null, pending_options: null, pending_token_vault_id: null, ...over }];
  tables.social_accounts = [];
}

// A plain OAuth adapter: no picker of its own.
const oauthAdapter = (over: Record<string, unknown> = {}) => ({
  platform: "linkedin",
  exchangeCode: vi.fn(async () => ({
    accessToken: "acc-token",
    refreshToken: "ref-token",
    expiresAt: "2026-11-29T00:00:00.000Z",
    platformAccountId: "li-42",
    displayName: "Luzaan Jacobs",
  })),
  ...over,
});
const registryOf = (adapter: { platform: string }) => new Map([[adapter.platform, adapter]]) as never;

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("plain OAuth platforms ask before connecting", () => {
  it("holds the login and returns a one-option confirmation, saving nothing", async () => {
    seedState();
    const adapter = oauthAdapter();
    const r = await completeConnect("st1", "code", registryOf(adapter));

    expect(r).toEqual({ status: "needs_selection", selectionToken: "st1", options: [{ id: "li-42", name: "Luzaan Jacobs" }] });
    expect(tables.social_accounts).toHaveLength(0); // NOT connected yet
    expect(tables.oauth_states).toHaveLength(1); // kept: it is the confirmation handle
    expect(tables.oauth_states[0].pending_options).toEqual([{ id: "li-42", name: "Luzaan Jacobs" }]);
    const held = [...vault.values()][0];
    expect(held).toContain("acc-token"); // the login is held server-side only
    const pending = await getPendingSelection("st1", "acc1");
    expect(pending.options).toHaveLength(1);
  });

  it("confirming stores the account exactly as a direct connect would, and scrubs the held copy", async () => {
    seedState();
    const adapter = oauthAdapter();
    await completeConnect("st1", "code", registryOf(adapter));
    const heldId = [...vault.keys()][0];

    const ids = await finalizeConnectSelection("st1", ["li-42"], "acc1", registryOf(adapter));

    expect(ids).toHaveLength(1);
    expect(tables.social_accounts).toHaveLength(1);
    expect(tables.social_accounts[0]).toMatchObject({
      account_id: "acc1",
      platform: "linkedin",
      platform_account_id: "li-42",
      display_name: "Luzaan Jacobs",
      token_expires_at: "2026-11-29T00:00:00.000Z",
      disconnected_at: null,
      needs_reconnect_at: null,
    });
    expect([...vault.values()]).toContain("acc-token"); // real token stored
    expect(vault.get(heldId)).toBe("discarded"); // the held confirmation copy is gone
    expect(tables.oauth_states).toHaveLength(0);
  });

  it("cancelling saves nothing, deletes the flow and scrubs the held login", async () => {
    seedState();
    const adapter = oauthAdapter();
    await completeConnect("st1", "code", registryOf(adapter));
    const heldId = [...vault.keys()][0];

    await cancelConnectSelection("st1", "acc1");

    expect(tables.social_accounts).toHaveLength(0);
    expect(tables.oauth_states).toHaveLength(0);
    expect(vault.get(heldId)).toBe("discarded");
    await expect(finalizeConnectSelection("st1", ["li-42"], "acc1", registryOf(adapter))).rejects.toThrow(/Invalid or already-used/);
  });

  it("another LazyRelay account can neither confirm nor cancel someone else's connect", async () => {
    seedState();
    const adapter = oauthAdapter();
    await completeConnect("st1", "code", registryOf(adapter));
    await expect(cancelConnectSelection("st1", "someone-else")).rejects.toThrow(/Not authorized/);
    expect(tables.oauth_states).toHaveLength(1); // untouched by the attempt
    await expect(getPendingSelection("st1", "someone-else")).rejects.toThrow(/Not authorized/);
    await expect(finalizeConnectSelection("st1", ["li-42"], "someone-else", registryOf(adapter))).rejects.toThrow(/Not authorized/);
    expect(tables.social_accounts).toHaveLength(0);
  });

  it("rejects an account id that wasn't the one shown", async () => {
    seedState();
    const adapter = oauthAdapter();
    await completeConnect("st1", "code", registryOf(adapter));
    await expect(finalizeConnectSelection("st1", ["li-999"], "acc1", registryOf(adapter))).rejects.toThrow(/wasn't part of the original list/);
    expect(tables.social_accounts).toHaveLength(0);
  });

  it("a failed code exchange deletes the flow and holds nothing", async () => {
    seedState();
    const adapter = oauthAdapter({ exchangeCode: vi.fn(async () => { throw new Error("platform said no"); }) });
    await expect(completeConnect("st1", "code", registryOf(adapter))).rejects.toThrow("platform said no");
    expect(tables.oauth_states).toHaveLength(0);
    expect(vault.size).toBe(0);
  });

  it("an expired flow is refused", async () => {
    seedState({ expires_at: new Date(Date.now() - 1000).toISOString() });
    await expect(completeConnect("st1", "code", registryOf(oauthAdapter()))).rejects.toThrow(/expired/);
  });

  it("reconnecting a known account updates it in place and clears any needs-reconnect flag", async () => {
    seedState();
    tables.social_accounts = [
      { id: "sa-old", account_id: "acc1", platform: "linkedin", platform_account_id: "li-42", disconnected_at: "2026-09-30T00:00:00Z", needs_reconnect_at: "2026-09-29T00:00:00Z", reconnect_notified_at: "2026-09-29T00:00:00Z" },
    ];
    const adapter = oauthAdapter();
    await completeConnect("st1", "code", registryOf(adapter));
    await finalizeConnectSelection("st1", ["li-42"], "acc1", registryOf(adapter));
    expect(tables.social_accounts).toHaveLength(1);
    expect(tables.social_accounts[0]).toMatchObject({ id: "sa-old", disconnected_at: null, needs_reconnect_at: null, reconnect_notified_at: null });
  });
});

describe("credential-form platforms are unchanged", () => {
  it("connects immediately with no confirmation step", async () => {
    seedState({ platform: "bluesky" });
    const adapter = oauthAdapter({ platform: "bluesky", skipConnectConfirmation: true });
    const r = await completeConnect("st1", "{}", registryOf(adapter));
    expect(r.status).toBe("connected");
    expect(tables.social_accounts).toHaveLength(1);
    expect(tables.oauth_states).toHaveLength(0);
  });
});

describe("Page/channel picker platforms", () => {
  const pickerAdapter = (options: Array<{ id: string; name: string }>) => ({
    platform: "facebook",
    listConnectOptions: vi.fn(async () => ({ userToken: "user-token", options })),
    finalizeConnectOption: vi.fn(async (_t: string, id: string) => ({
      accessToken: `page-token-${id}`,
      refreshToken: null,
      expiresAt: null,
      platformAccountId: id,
      displayName: `Page ${id}`,
    })),
  });

  it("a single Page now asks for confirmation instead of connecting silently", async () => {
    seedState({ platform: "facebook" });
    const adapter = pickerAdapter([{ id: "p1", name: "Only Page" }]);
    const r = await completeConnect("st1", "code", registryOf(adapter));
    expect(r.status).toBe("needs_selection");
    expect(tables.social_accounts).toHaveLength(0);
    await finalizeConnectSelection("st1", ["p1"], "acc1", registryOf(adapter));
    expect(adapter.finalizeConnectOption).toHaveBeenCalledWith("user-token", "p1");
    expect(tables.social_accounts).toHaveLength(1);
  });

  it("several Pages still let the customer choose which to connect", async () => {
    seedState({ platform: "facebook" });
    const adapter = pickerAdapter([{ id: "p1", name: "A" }, { id: "p2", name: "B" }]);
    const r = await completeConnect("st1", "code", registryOf(adapter));
    expect(r.status === "needs_selection" && r.options).toHaveLength(2);
    await finalizeConnectSelection("st1", ["p2"], "acc1", registryOf(adapter));
    expect(tables.social_accounts).toHaveLength(1);
    expect(tables.social_accounts[0].platform_account_id).toBe("p2");
  });
});
