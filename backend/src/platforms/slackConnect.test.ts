// Slack through the REAL connect flow (connect.ts): install, channel picker, finalize, reconnect. supabase and Vault
// are in-memory fakes and Slack's API is a stubbed fetch, so nothing real is reached.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables, vault } from "../testFakeSupabase.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, args: Record<string, unknown>) => f.fakeRpc(fn, args) } };
});
vi.mock("../accountLimits.js", () => ({ checkNewDistinctAccountLimit: vi.fn(async () => null) }));
vi.mock("../http/metaWebhook.js", () => ({ subscribePageToMessaging: vi.fn(async () => {}) }));

const { completeConnect, getPendingSelection, finalizeConnectSelection, cancelConnectSelection } = await import("./connect.js");
const { SlackAdapter } = await import("./slack.js");

const BOT_TOKEN = ["xoxb", "test", "placeholder", "token", "0123456789"].join("-");
const future = () => new Date(Date.now() + 10 * 60_000).toISOString();
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const registry = () => new Map([["slack", new SlackAdapter("cid", "csecret-placeholder", "https://api.example.org/cb")]]) as never;

function installServer(team = { id: "T0001", name: "Acme Corp" }, channels = [{ id: "C1", name: "general" }, { id: "C2", name: "random" }]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("oauth.v2.access")) return json({ ok: true, access_token: BOT_TOKEN, scope: "chat:write,chat:write.public,channels:read", team });
      if (String(url).includes("conversations.list")) return json({ ok: true, channels: channels.map((c) => ({ ...c, is_archived: false })), response_metadata: { next_cursor: "" } });
      return json({ ok: false, error: "unexpected" });
    }),
  );
}

function seedState(id = "st1", accountId = "acc1") {
  tables.oauth_states = [...(tables.oauth_states ?? []), { id, account_id: accountId, platform: "slack", expires_at: future(), pkce_verifier: null, pending_options: null, pending_token_vault_id: null }];
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
  tables.social_accounts = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("connecting Slack", () => {
  it("shows the channel picker, holds the bot token only in Vault, and saves nothing until a channel is picked", async () => {
    installServer();
    seedState();
    const r = await completeConnect("st1", "code", registry());
    expect(r).toEqual({
      status: "needs_selection",
      selectionToken: "st1",
      options: [
        { id: "T0001:C1", name: "#general (Acme Corp)" },
        { id: "T0001:C2", name: "#random (Acme Corp)" },
      ],
    });
    expect(tables.social_accounts).toHaveLength(0);
    expect(JSON.stringify(tables.oauth_states)).not.toContain(BOT_TOKEN); // the token is in Vault, not in the state row
    const pending = await getPendingSelection("st1", "acc1", registry());
    expect(pending.singleSelection).toBe(true);
    expect(JSON.stringify(pending)).not.toContain(BOT_TOKEN);
  });

  it("finalizing stores the chosen workspace and channel, with the bot token in Vault", async () => {
    installServer();
    seedState();
    await completeConnect("st1", "code", registry());
    const ids = await finalizeConnectSelection("st1", ["T0001:C2"], "acc1", registry());
    expect(ids).toHaveLength(1);
    expect(tables.social_accounts).toHaveLength(1);
    expect(tables.social_accounts[0]).toMatchObject({
      account_id: "acc1",
      platform: "slack",
      platform_account_id: "T0001:C2",
      display_name: "#random (Acme Corp)",
      refresh_token_vault_id: null,
      token_expires_at: null,
      needs_reconnect_at: null,
    });
    expect([...vault.values()]).toContain(BOT_TOKEN);
    // Exactly one Vault entry still holds the token: the held copy from the picker step was scrubbed.
    expect([...vault.values()].filter((v) => v.includes(BOT_TOKEN))).toHaveLength(1);
    expect(tables.social_accounts[0].access_token_vault_id).toBeTruthy();
    expect(JSON.stringify(tables.social_accounts)).not.toContain(BOT_TOKEN); // only a vault reference lives in the row
    expect(tables.oauth_states).toHaveLength(0);
  });

  it("reconnecting the same workspace and channel updates the one account instead of adding another, and clears needs-reconnect", async () => {
    installServer();
    seedState("st1");
    await completeConnect("st1", "code", registry());
    const [first] = await finalizeConnectSelection("st1", ["T0001:C1"], "acc1", registry());
    Object.assign(tables.social_accounts[0], { needs_reconnect_at: "2026-09-29T00:00:00Z", disconnected_at: "2026-09-30T00:00:00Z" });

    seedState("st2");
    await completeConnect("st2", "code", registry());
    const [second] = await finalizeConnectSelection("st2", ["T0001:C1"], "acc1", registry());

    expect(second).toBe(first);
    expect(tables.social_accounts).toHaveLength(1);
    expect(tables.social_accounts[0]).toMatchObject({ platform_account_id: "T0001:C1", needs_reconnect_at: null, disconnected_at: null });
  });

  it("a different channel (or workspace) is a separate account, and another customer's identical channel is separate too", async () => {
    installServer();
    seedState("st1");
    await completeConnect("st1", "code", registry());
    await finalizeConnectSelection("st1", ["T0001:C1"], "acc1", registry());
    seedState("st2");
    await completeConnect("st2", "code", registry());
    await finalizeConnectSelection("st2", ["T0001:C2"], "acc1", registry());
    installServer({ id: "T0002", name: "Other Co" });
    seedState("st3");
    await completeConnect("st3", "code", registry());
    await finalizeConnectSelection("st3", ["T0002:C1"], "acc1", registry());
    installServer();
    seedState("st4", "acc2");
    await completeConnect("st4", "code", registry());
    await finalizeConnectSelection("st4", ["T0001:C1"], "acc2", registry());

    expect(tables.social_accounts.map((a) => `${a.account_id}/${a.platform_account_id}`).sort()).toEqual(["acc1/T0001:C1", "acc1/T0001:C2", "acc1/T0002:C1", "acc2/T0001:C1"]);
  });

  it("a customer cannot connect a channel from a workspace they did not authorize, or one that was never offered", async () => {
    installServer();
    seedState();
    await completeConnect("st1", "code", registry());
    await expect(finalizeConnectSelection("st1", ["T9999:C1"], "acc1", registry())).rejects.toThrow(/wasn't part of the original list/);
    expect(tables.social_accounts).toHaveLength(0);

    seedState("st5");
    await completeConnect("st5", "code", registry());
    await expect(finalizeConnectSelection("st5", ["T0001:C1", "T0001:C2"], "acc1", registry())).rejects.toThrow(/Pick just one/);
    expect(tables.social_accounts).toHaveLength(0);
  });

  it("another LazyRelay account can neither read, finish nor cancel someone else's Slack connect", async () => {
    installServer();
    seedState();
    await completeConnect("st1", "code", registry());
    await expect(getPendingSelection("st1", "intruder", registry())).rejects.toThrow(/Not authorized/);
    await expect(cancelConnectSelection("st1", "intruder")).rejects.toThrow(/Not authorized/);
    await expect(finalizeConnectSelection("st1", ["T0001:C1"], "intruder", registry())).rejects.toThrow(/Not authorized/);
    expect(tables.social_accounts).toHaveLength(0);
  });

  it("a failed install saves nothing and leaves no held login", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ok: false, error: "invalid_code" })));
    seedState();
    await expect(completeConnect("st1", "code", registry())).rejects.toThrow(/already used or has expired/);
    expect(tables.social_accounts).toHaveLength(0);
    expect(vault.size).toBe(0);
  });

  it("cancelling scrubs the held bot token", async () => {
    installServer();
    seedState();
    await completeConnect("st1", "code", registry());
    const heldId = [...vault.keys()][0];
    expect(vault.get(heldId)).toContain(BOT_TOKEN);
    await cancelConnectSelection("st1", "acc1");
    expect(vault.get(heldId)).toBe("discarded");
    expect(tables.oauth_states).toHaveLength(0);
  });
});
