// The customer's chosen server (Mastodon instance) travels start -> oauth_states.context -> code
// exchange, and every other connect is untouched. supabase, Vault and the platform are fakes.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, args: Record<string, unknown>) => f.fakeRpc(fn, args) } };
});
vi.mock("./accountLimits.js", () => ({ checkNewDistinctAccountLimit: vi.fn(async () => null) }));
vi.mock("./http/metaWebhook.js", () => ({ subscribePageToMessaging: vi.fn(async () => {}) }));

const { startConnect, completeConnect } = await import("./platforms/connect.js");

const future = () => new Date(Date.now() + 10 * 60_000).toISOString();
const result = { accessToken: "acc", refreshToken: null, expiresAt: null, platformAccountId: "a@hachyderm.io", displayName: "A" };

const adapterOf = (platform: string, over: Record<string, unknown> = {}) => ({
  platform,
  getAuthorizeUrl: vi.fn(async (state: string) => `https://idp.example/authorize?state=${state}`),
  exchangeCode: vi.fn(async () => result),
  ...over,
});
const registryOf = (adapter: { platform: string }) => new Map([[adapter.platform, adapter]]) as never;

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
});

describe("startConnect", () => {
  it("without a context behaves as before: nothing extra stored, getAuthorizeUrl called with the state only", async () => {
    const adapter = adapterOf("mastodon");
    const { url, stateId } = await startConnect("acc1", "mastodon", registryOf(adapter));
    expect(url).toContain(stateId);
    expect(tables.oauth_states).toHaveLength(1);
    expect(tables.oauth_states[0]).not.toHaveProperty("context");
    expect(adapter.getAuthorizeUrl).toHaveBeenCalledWith(stateId);
  });

  it("with a context stores it on the state row and hands it to the adapter", async () => {
    const adapter = adapterOf("mastodon");
    const { stateId } = await startConnect("acc1", "mastodon", registryOf(adapter), "https://hachyderm.io");
    expect(tables.oauth_states[0]).toMatchObject({ id: stateId, account_id: "acc1", platform: "mastodon", context: "https://hachyderm.io" });
    expect(adapter.getAuthorizeUrl).toHaveBeenCalledWith(stateId, "https://hachyderm.io");
  });
});

describe("per-day cap on different Mastodon servers", () => {
  it("allows repeats of the same server and up to 5 different ones, then refuses a 6th with a plain message", async () => {
    const adapter = adapterOf("mastodon");
    const reg = registryOf(adapter);
    for (const h of ["a", "b", "c", "d", "e"]) await startConnect("acc1", "mastodon", reg, `https://${h}.example`);
    await startConnect("acc1", "mastodon", reg, "https://a.example"); // same server again: fine
    const err = (await startConnect("acc1", "mastodon", reg, "https://f.example").catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/up to 5 different Mastodon servers per day/);
    expect(err.message).not.toMatch(/[\u2013\u2014]/);
    expect(adapter.getAuthorizeUrl).toHaveBeenCalledTimes(6);
  });

  it("another LazyRelay account has its own allowance, and the default server never counts", async () => {
    const adapter = adapterOf("mastodon");
    const reg = registryOf(adapter);
    for (const h of ["a", "b", "c", "d", "e"]) await startConnect("acc1", "mastodon", reg, `https://${h}.example`);
    await expect(startConnect("acc2", "mastodon", reg, "https://f.example")).resolves.toBeDefined();
    await expect(startConnect("acc1", "mastodon", reg)).resolves.toBeDefined();
  });

  it("servers tried more than a day ago no longer count", async () => {
    const { checkMastodonInstanceLimit } = await import("./platforms/mastodonInstanceLimit.js");
    const t0 = Date.now();
    for (const h of ["a", "b", "c", "d", "e"]) await checkMastodonInstanceLimit("acc1", `https://${h}.example`, t0);
    await expect(checkMastodonInstanceLimit("acc1", "https://f.example", t0 + 25 * 3_600_000)).resolves.toBeUndefined();
  });
});

describe("completeConnect", () => {
  it("a failed state read stops the flow and never reaches the code exchange", async () => {
    tables.oauth_states = [];
    const adapter = adapterOf("mastodon");
    await expect(completeConnect("missing", "the-code", registryOf(adapter))).rejects.toThrow(/Invalid or already-used/);
    expect(adapter.exchangeCode).not.toHaveBeenCalled();
  });

  it("a blank stored context is still the default mastodon.social flow", async () => {
    tables.oauth_states = [{ id: "st1", account_id: "acc1", platform: "mastodon", expires_at: future(), pkce_verifier: null, pending_options: null, pending_token_vault_id: null, context: "  " }];
    tables.social_accounts = [];
    const adapter = adapterOf("mastodon");
    await completeConnect("st1", "the-code", registryOf(adapter));
    expect(adapter.exchangeCode).toHaveBeenCalledWith("the-code", undefined, undefined);
  });

  const seed = (over: Record<string, unknown> = {}) => {
    tables.oauth_states = [{ id: "st1", account_id: "acc1", platform: "mastodon", expires_at: future(), pkce_verifier: null, pending_options: null, pending_token_vault_id: null, ...over }];
    tables.social_accounts = [];
  };

  it("passes the chosen instance to exchangeCode", async () => {
    seed({ context: "https://hachyderm.io" });
    const adapter = adapterOf("mastodon");
    await completeConnect("st1", "the-code", registryOf(adapter));
    expect(adapter.exchangeCode).toHaveBeenCalledWith("the-code", undefined, "https://hachyderm.io");
  });

  it("passes it on the credential-form path too", async () => {
    seed({ context: "https://hachyderm.io" });
    const adapter = adapterOf("mastodon", { skipConnectConfirmation: true });
    await completeConnect("st1", "the-code", registryOf(adapter));
    expect(adapter.exchangeCode).toHaveBeenCalledWith("the-code", undefined, "https://hachyderm.io");
  });

  it("a Mastodon flow started without an instance exchanges with no context (mastodon.social)", async () => {
    seed();
    const adapter = adapterOf("mastodon");
    await completeConnect("st1", "the-code", registryOf(adapter));
    expect(adapter.exchangeCode).toHaveBeenCalledWith("the-code", undefined, undefined);
  });

  it("another platform never gets a context, even if the row somehow had one", async () => {
    seed({ platform: "linkedin", context: "https://hachyderm.io" });
    const adapter = adapterOf("linkedin");
    await completeConnect("st1", "the-code", registryOf(adapter));
    expect(adapter.exchangeCode).toHaveBeenCalledWith("the-code", undefined, undefined);
  });
});
