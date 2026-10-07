// Behavior tests for token health: proactive Threads refresh, warnings for
// platforms that can't renew, the needs-reconnect flag, and the customer
// email. supabase is an in-memory fake; no real database, platform or
// mailbox is touched.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables } from "./testFakeSupabase.js";

const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data: "stored-token", error: null }));
vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, args: Record<string, unknown>) => rpc(fn, args) } };
});
const notifyOps = vi.fn(async (_m: string) => {});
vi.mock("./notify.js", () => ({ notifyOps: (m: string) => notifyOps(m) }));
const sendReconnectNeededEmail = vi.fn();
vi.mock("./email.js", () => ({
  sendFailureAlert: vi.fn(),
  sendAccountPausedAlert: vi.fn(),
  sendReconnectNeededEmail: (...a: unknown[]) => sendReconnectNeededEmail(...a),
}));
const dispatchWebhookEvent = vi.fn(async (_e: Record<string, unknown>) => {});
vi.mock("./webhook.js", () => ({ dispatchWebhookEvent: (e: Record<string, unknown>) => dispatchWebhookEvent(e) }));

const { runTokenRefreshCycle } = await import("./tokenRefresher.js");
const { getAccessToken, DisconnectedAccountError } = await import("./scheduler.js");
const { isPermanentAuthError } = await import("./tokenHealth.js");

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const inDays = (d: number) => new Date(NOW + d * DAY).toISOString();

function seedAccount(platform: string, expiresInDays: number | null, extra: Record<string, unknown> = {}, email = "jane.doe@acme-studio.co") {
  tables.accounts = [{ id: "acc1", email }];
  tables.social_accounts = [
    {
      id: "sa1",
      account_id: "acc1",
      platform,
      display_name: "My Account",
      access_token_vault_id: "vault-access",
      refresh_token_vault_id: null,
      token_expires_at: expiresInDays === null ? null : inDays(expiresInDays),
      needs_reconnect_at: null,
      needs_reconnect_reason: null,
      reconnect_notified_at: null,
      disconnected_at: null,
      ...extra,
    },
  ];
}

// A threads-like adapter (renews in place) and a linkedin-like one (cannot renew).
const threadsAdapter = () => ({
  platform: "threads",
  refreshUsesAccessToken: true,
  refresh: vi.fn(async (_token: string) => ({
    accessToken: "new-token",
    refreshToken: null,
    expiresAt: inDays(60),
    platformAccountId: "",
    displayName: "",
  })),
});
const linkedinAdapter = () => ({ platform: "linkedin" });
const tiktokAdapter = () => ({ platform: "tiktok", refresh: vi.fn(async () => ({ accessToken: "x", refreshToken: "y", expiresAt: inDays(1), platformAccountId: "", displayName: "" })) });
const registryOf = (...adapters: Array<{ platform: string }>) =>
  ({ get: (p: string) => adapters.find((a) => a.platform === p) }) as never;

beforeEach(() => {
  // getAccessToken reads the real clock; pin it to the same instant the cycle tests use.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const k of Object.keys(tables)) delete tables[k];
  rpc.mockClear();
  notifyOps.mockClear();
  dispatchWebhookEvent.mockClear();
  sendReconnectNeededEmail.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("proactive Threads refresh", () => {
  it("renews a Threads token expiring in 5 days, using the current access token, and stores the new one", async () => {
    seedAccount("threads", 5);
    const adapter = threadsAdapter();
    const r = await runTokenRefreshCycle(registryOf(adapter), NOW);
    expect(r).toMatchObject({ refreshed: 1, flagged: 0, failed: 0 });
    expect(adapter.refresh).toHaveBeenCalledWith("stored-token"); // read from the ACCESS vault entry
    expect(rpc).toHaveBeenCalledWith("read_social_token", { p_vault_id: "vault-access" });
    expect(rpc).toHaveBeenCalledWith("update_social_token", { p_vault_id: "vault-access", p_new_token: "new-token" });
    expect(tables.social_accounts[0].token_expires_at).toBe(inDays(60));
    expect(sendReconnectNeededEmail).not.toHaveBeenCalled();
  });

  it("leaves a Threads token with plenty of time alone", async () => {
    seedAccount("threads", 30);
    const adapter = threadsAdapter();
    await runTokenRefreshCycle(registryOf(adapter), NOW);
    expect(adapter.refresh).not.toHaveBeenCalled();
  });

  it("flags an already-expired Threads token instead of trying to refresh it, and emails the customer", async () => {
    seedAccount("threads", -1);
    const adapter = threadsAdapter();
    const r = await runTokenRefreshCycle(registryOf(adapter), NOW);
    expect(adapter.refresh).not.toHaveBeenCalled(); // Meta cannot renew an expired token
    expect(r.flagged).toBe(1);
    expect(tables.social_accounts[0].needs_reconnect_at).toBeTruthy();
    expect(sendReconnectNeededEmail).toHaveBeenCalledTimes(1);
    expect(sendReconnectNeededEmail.mock.calls[0][0]).toBe("jane.doe@acme-studio.co");
    expect(sendReconnectNeededEmail.mock.calls[0][3]).toBe(true); // expired
  });

  it("a transient refresh failure is retried later, and warns the customer only in the last 3 days", async () => {
    seedAccount("threads", 5);
    const adapter = threadsAdapter();
    adapter.refresh.mockRejectedValue(new Error("network down"));
    let r = await runTokenRefreshCycle(registryOf(adapter), NOW);
    expect(r).toMatchObject({ failed: 1, flagged: 0, warned: 0 });
    expect(sendReconnectNeededEmail).not.toHaveBeenCalled();

    seedAccount("threads", 2);
    r = await runTokenRefreshCycle(registryOf(adapter), NOW);
    expect(r.warned).toBe(1);
    expect(sendReconnectNeededEmail.mock.calls[0][3]).toBe(false); // expires soon, not expired
    expect(tables.social_accounts[0].needs_reconnect_at).toBeNull(); // still works, so not flagged
  });

  it("a refresh the platform permanently rejects flags the account", async () => {
    seedAccount("threads", 5);
    const adapter = threadsAdapter();
    adapter.refresh.mockRejectedValue(new Error("Error validating access token: the session has been invalidated"));
    const r = await runTokenRefreshCycle(registryOf(adapter), NOW);
    expect(r.flagged).toBe(1);
    expect(tables.social_accounts[0].needs_reconnect_at).toBeTruthy();
  });
});

describe("platforms that cannot renew (LinkedIn)", () => {
  it("warns once, 14 days ahead, without flagging the still-working account", async () => {
    seedAccount("linkedin", 10);
    let r = await runTokenRefreshCycle(registryOf(linkedinAdapter()), NOW);
    expect(r.warned).toBe(1);
    expect(sendReconnectNeededEmail).toHaveBeenCalledTimes(1);
    expect(tables.social_accounts[0].needs_reconnect_at).toBeNull();
    // Running again must not email again.
    r = await runTokenRefreshCycle(registryOf(linkedinAdapter()), NOW + 6 * 3_600_000);
    expect(sendReconnectNeededEmail).toHaveBeenCalledTimes(1);
  });

  it("does nothing more than 14 days out", async () => {
    seedAccount("linkedin", 40);
    await runTokenRefreshCycle(registryOf(linkedinAdapter()), NOW);
    expect(sendReconnectNeededEmail).not.toHaveBeenCalled();
  });

  it("flags it once it has expired", async () => {
    seedAccount("linkedin", -2);
    const r = await runTokenRefreshCycle(registryOf(linkedinAdapter()), NOW);
    expect(r.flagged).toBe(1);
    expect(tables.social_accounts[0].needs_reconnect_at).toBeTruthy();
  });
});

describe("webhook events for reconnects", () => {
  it("raises channel.needs_reconnect once when an account first needs reconnecting", async () => {
    seedAccount("linkedin", -2);
    await runTokenRefreshCycle(registryOf(linkedinAdapter()), NOW);
    await runTokenRefreshCycle(registryOf(linkedinAdapter()), NOW + 6 * 3_600_000); // the next run must not repeat it
    expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc1", event: "channel.needs_reconnect", socialAccountId: "sa1", data: expect.objectContaining({ platform: "linkedin" }) }),
    );
  });

  it("an expiry warning (the account still works) raises nothing", async () => {
    seedAccount("linkedin", 10);
    await runTokenRefreshCycle(registryOf(linkedinAdapter()), NOW);
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
  });
});

describe("who gets emailed", () => {
  it("our own internal accounts get an ops notice, never a customer email", async () => {
    seedAccount("linkedin", 5, {}, "lazyrelay@gmail.com");
    await runTokenRefreshCycle(registryOf(linkedinAdapter()), NOW);
    expect(sendReconnectNeededEmail).not.toHaveBeenCalled();
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(tables.social_accounts[0].reconnect_notified_at).toBeTruthy(); // not re-announced every run
  });

  it("platforms with a stored refresh token are left to the on-demand refresh", async () => {
    seedAccount("tiktok", 0.5, { refresh_token_vault_id: "vault-refresh" });
    const adapter = tiktokAdapter();
    await runTokenRefreshCycle(registryOf(adapter), NOW);
    expect(adapter.refresh).not.toHaveBeenCalled();
    expect(sendReconnectNeededEmail).not.toHaveBeenCalled();
  });

  it("disconnected accounts are ignored", async () => {
    seedAccount("linkedin", -5, { disconnected_at: inDays(-10) });
    const r = await runTokenRefreshCycle(registryOf(linkedinAdapter()), NOW);
    expect(r).toMatchObject({ flagged: 0, warned: 0 });
  });
});

describe("getAccessToken at post time", () => {
  it("fails with a clear reconnect message and flags a LinkedIn token that has really expired", async () => {
    seedAccount("linkedin", -1, {}, "jane.doe@acme-studio.co");
    await expect(getAccessToken("sa1", linkedinAdapter() as never)).rejects.toThrow(/expired on .* Reconnect it in Social Platforms/);
    expect(tables.social_accounts[0].needs_reconnect_at).toBeTruthy();
    expect(sendReconnectNeededEmail).toHaveBeenCalledTimes(1);
  });

  it("refuses an account the customer disconnected: a clear typed error, and its login is never read", async () => {
    seedAccount("linkedin", 30, { disconnected_at: new Date().toISOString() });
    rpc.mockClear();
    await expect(getAccessToken("sa1", linkedinAdapter() as never)).rejects.toBeInstanceOf(DisconnectedAccountError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("still reads a normal, unexpired token unchanged", async () => {
    seedAccount("linkedin", 30);
    expect(await getAccessToken("sa1", linkedinAdapter() as never)).toBe("stored-token");
    expect(sendReconnectNeededEmail).not.toHaveBeenCalled();
  });

  it("a token with no expiry (Facebook/Instagram Page tokens) is never touched", async () => {
    seedAccount("facebook", null);
    expect(await getAccessToken("sa1", { platform: "facebook" } as never)).toBe("stored-token");
  });

  it("a successful refresh clears an earlier needs-reconnect flag", async () => {
    seedAccount("threads", 0.001, { needs_reconnect_at: inDays(-1), reconnect_notified_at: inDays(-1) });
    const adapter = threadsAdapter();
    await getAccessToken("sa1", adapter as never);
    expect(tables.social_accounts[0].needs_reconnect_at).toBeNull();
    expect(tables.social_accounts[0].reconnect_notified_at).toBeNull();
  });

  it("a permanently rejected refresh on a refresh-token platform flags the account and still throws", async () => {
    seedAccount("tiktok", -1, { refresh_token_vault_id: "vault-refresh" });
    const adapter = tiktokAdapter();
    adapter.refresh.mockRejectedValue(new Error("invalid_grant: refresh token is expired"));
    await expect(getAccessToken("sa1", adapter as never)).rejects.toThrow(/invalid_grant/);
    expect(tables.social_accounts[0].needs_reconnect_at).toBeTruthy();
  });

  it("OUR bad app secret (invalid_client) never flags the customer", async () => {
    seedAccount("tiktok", -1, { refresh_token_vault_id: "vault-refresh" });
    const adapter = tiktokAdapter();
    adapter.refresh.mockRejectedValue(new Error("invalid_client: client key or secret is incorrect"));
    await expect(getAccessToken("sa1", adapter as never)).rejects.toThrow(/invalid_client/);
    expect(tables.social_accounts[0].needs_reconnect_at).toBeNull();
    expect(sendReconnectNeededEmail).not.toHaveBeenCalled();
  });
});

describe("isPermanentAuthError", () => {
  it.each([
    ["invalid_grant", true],
    ["Refresh token is expired", true],
    ["the session has been invalidated", true],
    ["invalid_client: bad secret", false],
    ["invalid_client invalid_grant", false],
    ["network timeout", false],
    ["rate limit exceeded", false],
  ])("%s -> %s", (message, expected) => {
    expect(isPermanentAuthError(new Error(message))).toBe(expected);
  });
});
