// X bring-your-own-key in the scheduler: one customer's empty X wallet or dead keys must never stop anyone else, the
// failure is the customer's (so ops is never told), and an X connection without the customer's own keys is dropped
// cleanly. supabase is an in-memory fake, nothing real is touched.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: "token", error: null }) } };
});
const notifyOps = vi.fn(async (_m: string) => {});
vi.mock("./notify.js", () => ({ notifyOps: (m: string) => notifyOps(m) }));
const sendReconnectNeededEmail = vi.fn();
vi.mock("./email.js", () => ({ sendFailureAlert: vi.fn(), sendAccountPausedAlert: vi.fn(), sendPinterestPausedAlert: vi.fn(), sendReconnectNeededEmail: (...a: unknown[]) => sendReconnectNeededEmail(...a) }));
const dispatchWebhookEvent = vi.fn(async (_e: Record<string, unknown>) => {});
vi.mock("./webhook.js", () => ({ dispatchWebhookEvent: (e: Record<string, unknown>) => dispatchWebhookEvent(e) }));

const { runSchedulerCycle, breakerKey, classifierPlatform, BYOK_CONSECUTIVE_FAILURE_THRESHOLD } = await import("./scheduler.js");
const { X_BYOK_CREDIT_MESSAGE, X_BYOK_INVALID_KEYS_MESSAGE } = await import("./postErrors.js");
const { X_NOT_BYOK_MESSAGE, X_BUNDLE_INVALID_CODE } = await import("./platforms/xByok.js");

const MIN = 60_000;
let n = 0;

function account(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    account_id: "acc1",
    platform: "x",
    platform_account_id: `x-${id}`,
    display_name: `Handle ${id}`,
    paused_at: null,
    credential_mode: "byok",
    byok_status: "valid",
    access_token_vault_id: `v-${id}`,
    refresh_token_vault_id: null,
    token_expires_at: null,
    needs_reconnect_at: null,
    reconnect_notified_at: null,
    ...over,
  };
}
function addPost(socialAccountId: string) {
  n += 1;
  tables.scheduled_posts.push({ id: `p${n}`, account_id: "acc1", social_account_id: socialAccountId, content: "hello", media_url: null, retry_count: 0, status: "pending", paused_at: null, scheduled_for: new Date(Date.now() - MIN).toISOString(), updated_at: new Date().toISOString() });
  return `p${n}`;
}
const ok = { success: true, platformPostId: "t1", errorMessage: null };
const fail = (msg: string) => ({ success: false, platformPostId: null, errorMessage: msg });
const xAdapter = (post: (req: { socialAccountId: string }) => unknown) => ({
  platform: "x",
  byok: true,
  post: vi.fn(async (req: { socialAccountId: string }) => post(req)),
  verifyPublished: vi.fn(async () => ({ verifiedLive: true, platformPostUrl: "https://x.com/i/status/t1", errorMessage: null })),
});
const registryOf = (a: { platform: string }) => ({ get: (p: string) => (p === a.platform ? a : undefined) }) as never;
const row = (id: string) => tables.social_accounts.find((r) => r.id === id)!;
const postRow = (id: string) => tables.scheduled_posts.find((r) => r.id === id)!;

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.accounts = [{ id: "acc1", email: "jane.doe@acme-studio.co", email_failure_alerts_enabled: false, show_branding_tag: false }];
  tables.scheduled_posts = [];
  tables.post_results = [];
  notifyOps.mockClear();
  dispatchWebhookEvent.mockClear();
  sendReconnectNeededEmail.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("keys", () => {
  it("only a customer-owned connection gets a per-account breaker and the x_byok rule set", () => {
    expect(breakerKey("x", "sa1", "byok")).toBe("x:sa1");
    expect(breakerKey("x", "sa1", "platform")).toBe("x");
    expect(breakerKey("tiktok", "sa1", undefined)).toBe("tiktok");
    expect(classifierPlatform("x", "byok")).toBe("x_byok");
    expect(classifierPlatform("x", "platform")).toBe("x");
    expect(classifierPlatform("tiktok", "byok")).toBe("tiktok");
  });
});

describe("per-account failure isolation", () => {
  it("five failures on account A stop account A only: account B keeps posting, and ops is never told", async () => {
    tables.social_accounts = [account("saA"), account("saB")];
    const adapter = xAdapter((req) => (req.socialAccountId === "saA" ? fail("x_api_error status=503 title=\"Service Unavailable\"") : ok));
    const bPosts: string[] = [];
    for (let i = 0; i < 5; i++) {
      addPost("saA");
      bPosts.push(addPost("saB"));
      await runSchedulerCycle(registryOf(adapter));
    }
    const calls = adapter.post.mock.calls.map((c) => c[0].socialAccountId);
    expect(calls.filter((id) => id === "saA")).toHaveLength(BYOK_CONSECUTIVE_FAILURE_THRESHOLD); // A: breaker open after 3, the rest held back
    expect(calls.filter((id) => id === "saB")).toHaveLength(5); // B: never affected
    for (const id of bPosts) expect(postRow(id).status).toBe("posted");
    expect(notifyOps).not.toHaveBeenCalled(); // the breaker trip is the customer's problem, not ops'
  });

  it("an empty wallet is fatal: never retried, never counted toward any breaker, status out_of_credit", async () => {
    tables.social_accounts = [account("saC")];
    const adapter = xAdapter(() => fail('x_api_error status=402 type=https://api.x.com/2/problems/credits title="CreditsDepleted" detail="Your enrolled account does not have any credits"'));
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(addPost("saC"));
      await runSchedulerCycle(registryOf(adapter));
    }
    expect(adapter.post).toHaveBeenCalledTimes(6); // the breaker never opened
    for (const id of ids) {
      expect(postRow(id).status).toBe("failed");
      expect(postRow(id).retry_count).toBe(0);
    }
    expect(String(tables.post_results[0].error_message)).toBe(X_BYOK_CREDIT_MESSAGE);
    expect(row("saC").byok_status).toBe("out_of_credit");
    expect(row("saC").needs_reconnect_at).toBeNull(); // not a reconnect problem
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("dead keys (401) fail at once, flag the account for reconnect, mark the keys invalid and tell the customer, not ops", async () => {
    tables.social_accounts = [account("saD")];
    const adapter = xAdapter(() => fail('x_api_error status=401 title="Unauthorized" detail="Unauthorized"'));
    const id = addPost("saD");
    await runSchedulerCycle(registryOf(adapter));
    expect(postRow(id).status).toBe("failed");
    expect(String(tables.post_results[0].error_message)).toBe(X_BYOK_INVALID_KEYS_MESSAGE);
    expect(row("saD").byok_status).toBe("invalid");
    expect(row("saD").needs_reconnect_at).not.toBeNull();
    expect(sendReconnectNeededEmail).toHaveBeenCalledTimes(1);
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("a rate limit is retried no sooner than X's reset time", async () => {
    tables.social_accounts = [account("saE")];
    const resetSeconds = Math.floor(Date.now() / 1000) + 10 * 60;
    const adapter = xAdapter(() => fail(`x_api_error status=429 title="Too Many Requests" reset=${resetSeconds}`));
    const id = addPost("saE");
    await runSchedulerCycle(registryOf(adapter));
    expect(postRow(id).status).toBe("pending");
    expect(postRow(id).retry_count).toBe(1);
    expect(new Date(postRow(id).scheduled_for as string).getTime()).toBeGreaterThanOrEqual(resetSeconds * 1000 - 1000);
  });

  it("a successful post puts the key status back to valid", async () => {
    tables.social_accounts = [account("saF", { byok_status: "out_of_credit" })];
    const adapter = xAdapter(() => ok);
    addPost("saF");
    await runSchedulerCycle(registryOf(adapter));
    expect(row("saF").byok_status).toBe("valid");
  });
});

describe("an X connection that does not use the customer's own keys", () => {
  it("is dropped cleanly: never sent to X, fixed reason, flagged for reconnect, no breaker, no ops notice", async () => {
    tables.accounts = [{ id: "acc1", email: null, email_failure_alerts_enabled: false, show_branding_tag: false }]; // no customer email: the old path told ops
    tables.social_accounts = [account("saG", { credential_mode: "platform", byok_status: null })];
    const adapter = xAdapter(() => ok);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push(addPost("saG"));
      await runSchedulerCycle(registryOf(adapter));
    }
    expect(adapter.post).not.toHaveBeenCalled();
    expect(adapter.verifyPublished).not.toHaveBeenCalled();
    for (const id of ids) {
      expect(postRow(id).status).toBe("failed");
      expect(postRow(id).retry_count).toBe(0); // no retry
    }
    expect(String(tables.post_results[0].error_message)).toBe(X_NOT_BYOK_MESSAGE);
    expect(tables.post_results[0].raw_error_message).toBe(X_BUNDLE_INVALID_CODE);
    expect(row("saG").needs_reconnect_at).not.toBeNull();
    expect(notifyOps).not.toHaveBeenCalled(); // neither the reconnect flag nor a breaker trip (7 drops, threshold is 5)
  });

  it("a stored login that is damaged on a byok connection is the same clean drop, via the adapter's code", async () => {
    tables.social_accounts = [account("saH")];
    const adapter = xAdapter(() => fail(X_BUNDLE_INVALID_CODE));
    const id = addPost("saH");
    await runSchedulerCycle(registryOf(adapter));
    expect(postRow(id).status).toBe("failed");
    expect(String(tables.post_results[0].error_message)).toBe(X_NOT_BYOK_MESSAGE);
    expect(notifyOps).not.toHaveBeenCalled();
  });
});
