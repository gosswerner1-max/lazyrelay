// WhatsApp bring-your-own-key in the scheduler: one customer's Meta fault (a dead token, a billing problem, a rate limit)
// must never stop another customer or another platform, is the customer's to fix (so ops is never told), and writes its
// status to that one connection's row only. supabase is an in-memory fake and the adapters are stubs: nothing real is
// touched and Meta is never called.

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

// These tests are about what happens when a WhatsApp post DOES reach the adapter, which today the scheduler's
// "sending is not built" guard prevents (schedulerWhatsappIntercept.test.ts covers that). Pretend sending is built.
vi.mock("./platforms/whatsapp/sendSupport.js", async (orig) => ({ ...(await orig<typeof import("./platforms/whatsapp/sendSupport.js")>()), whatsappSendingSupported: () => true, isWhatsappSendBlocked: () => false }));

const { runSchedulerCycle, breakerKey, classifierPlatform, BYOK_CONSECUTIVE_FAILURE_THRESHOLD } = await import("./scheduler.js");
const { WHATSAPP_BILLING_MESSAGE, WHATSAPP_INVALID_TOKEN_MESSAGE } = await import("./postErrors.js");
const { WHATSAPP_NOT_BYOK_MESSAGE, WHATSAPP_BUNDLE_INVALID_CODE } = await import("./platforms/whatsapp/credentials.js");

const MIN = 60_000;
let n = 0;

function account(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    account_id: "acc1",
    platform: "whatsapp",
    platform_account_id: `wa-${id}`,
    display_name: `Number ${id}`,
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
const adapterOf = (platform: string, post: (req: { socialAccountId: string }) => unknown) => ({
  platform,
  post: vi.fn(async (req: { socialAccountId: string }) => post(req)),
  verifyPublished: vi.fn(async () => ({ verifiedLive: true, platformPostUrl: "https://example.test/post/t1", errorMessage: null })),
});
type Stub = ReturnType<typeof adapterOf>;
const registryOf = (...adapters: Stub[]) => ({ get: (p: string) => adapters.find((a) => a.platform === p) }) as never;
const row = (id: string) => tables.social_accounts.find((r) => r.id === id)!;
const postRow = (id: string) => tables.scheduled_posts.find((r) => r.id === id)!;
const META_RETRY = "whatsapp_api_error status=503 code=131016"; // service unavailable: a retry-class fault

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
  it("a WhatsApp connection always gets a per-account breaker key; other platforms are unchanged", () => {
    expect(breakerKey("whatsapp", "sa1", "byok")).toBe("whatsapp:sa1");
    expect(breakerKey("whatsapp", "sa1", undefined)).toBe("whatsapp:sa1");
    expect(breakerKey("whatsapp", "sa1", "platform")).toBe("whatsapp:sa1");
    expect(breakerKey("telegram", "sa1", undefined)).toBe("telegram");
    expect(breakerKey("tiktok", "sa1", "platform")).toBe("tiktok");
    expect(breakerKey("x", "sa1", "byok")).toBe("x:sa1");
    expect(classifierPlatform("whatsapp", "byok")).toBe("whatsapp");
  });
});

describe("per-account failure isolation", () => {
  it("five failures on WhatsApp account A stop A only: account B and every other platform keep posting, and ops is never told", async () => {
    tables.social_accounts = [account("waA2"), account("waB2"), account("tgC", { platform: "telegram", platform_account_id: "tg1", credential_mode: "platform", byok_status: null })];
    const wa = adapterOf("whatsapp", (req) => (req.socialAccountId === "waA2" ? fail(META_RETRY) : ok));
    const tg = adapterOf("telegram", () => ok);
    const bPosts: string[] = [];
    const cPosts: string[] = [];
    for (let i = 0; i < 5; i++) {
      addPost("waA2");
      bPosts.push(addPost("waB2"));
      cPosts.push(addPost("tgC"));
      await runSchedulerCycle(registryOf(wa, tg));
    }
    const calls = wa.post.mock.calls.map((c) => c[0].socialAccountId);
    expect(calls.filter((id) => id === "waA2")).toHaveLength(BYOK_CONSECUTIVE_FAILURE_THRESHOLD); // A: breaker open after 3, the rest held back
    expect(calls.filter((id) => id === "waB2")).toHaveLength(5); // B: never affected
    for (const id of bPosts) expect(postRow(id).status).toBe("posted");
    expect(tg.post).toHaveBeenCalledTimes(5); // another platform: never affected
    for (const id of cPosts) expect(postRow(id).status).toBe("posted");
    expect(notifyOps).not.toHaveBeenCalled(); // the breaker trip is the customer's problem, not ops'
    expect(row("waB2").byok_status).toBe("valid");
    expect(row("tgC").byok_status).toBeNull();
  });

  it("a billing fault (131042) is fatal: never retried, never counted toward any breaker, out_of_credit on THAT row only", async () => {
    tables.social_accounts = [account("waA3"), account("waB3")];
    const wa = adapterOf("whatsapp", (req) => (req.socialAccountId === "waA3" ? fail("whatsapp_api_error status=400 code=131042") : ok));
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(addPost("waA3"));
      addPost("waB3");
      await runSchedulerCycle(registryOf(wa));
    }
    expect(wa.post.mock.calls.filter((c) => c[0].socialAccountId === "waA3")).toHaveLength(6); // the breaker never opened
    for (const id of ids) {
      expect(postRow(id).status).toBe("failed");
      expect(postRow(id).retry_count).toBe(0);
    }
    expect(String(tables.post_results.find((r) => r.scheduled_post_id === ids[0])?.error_message)).toBe(WHATSAPP_BILLING_MESSAGE);
    expect(row("waA3").byok_status).toBe("out_of_credit");
    expect(row("waA3").needs_reconnect_at).toBeNull(); // not a reconnect problem
    expect(row("waB3").byok_status).toBe("valid"); // the other account's row was never touched
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("a dead or under-permissioned token (190) fails at once, flags A for reconnect, marks A invalid, tells the customer and never ops", async () => {
    tables.social_accounts = [account("waA4"), account("waB4")];
    const wa = adapterOf("whatsapp", (req) => (req.socialAccountId === "waA4" ? fail('{"error":{"type":"OAuthException","code":190}}') : ok));
    const id = addPost("waA4");
    const idB = addPost("waB4");
    await runSchedulerCycle(registryOf(wa));
    expect(postRow(id).status).toBe("failed");
    expect(postRow(id).retry_count).toBe(0);
    expect(String(tables.post_results.find((r) => r.scheduled_post_id === id)?.error_message)).toBe(WHATSAPP_INVALID_TOKEN_MESSAGE);
    expect(row("waA4").byok_status).toBe("invalid");
    expect(row("waA4").needs_reconnect_at).not.toBeNull();
    expect(sendReconnectNeededEmail).toHaveBeenCalledTimes(1);
    expect(notifyOps).not.toHaveBeenCalled(); // a reconnect fault never calls notifyOps
    expect(postRow(idB).status).toBe("posted");
    expect(row("waB4").byok_status).toBe("valid");
    expect(row("waB4").needs_reconnect_at).toBeNull();
  });

  it("a rate limit (130429) is retried with the normal backoff and counts only toward that account's breaker", async () => {
    tables.social_accounts = [account("waA5")];
    const wa = adapterOf("whatsapp", () => fail("whatsapp_api_error status=429 code=130429"));
    const id = addPost("waA5");
    await runSchedulerCycle(registryOf(wa));
    expect(postRow(id).status).toBe("pending");
    expect(postRow(id).retry_count).toBe(1);
    expect(row("waA5").byok_status).toBe("valid"); // a rate limit says nothing about the credentials
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("131049 (Meta asks us to wait) is pushed out about a day, not the usual few minutes", async () => {
    tables.social_accounts = [account("waA6")];
    const wa = adapterOf("whatsapp", () => fail("whatsapp_api_error status=400 code=131049"));
    const id = addPost("waA6");
    await runSchedulerCycle(registryOf(wa));
    expect(postRow(id).status).toBe("pending");
    expect(postRow(id).retry_count).toBe(1);
    expect(new Date(postRow(id).scheduled_for as string).getTime()).toBeGreaterThan(Date.now() + 23 * 60 * MIN);
  });

  it("a retry-class fault that ends in a permanent failure still does not tell ops (the customer owns these credentials)", async () => {
    tables.social_accounts = [account("waA7")];
    const wa = adapterOf("whatsapp", () => fail("something odd with no code"));
    const id = addPost("waA7");
    postRow(id).retry_count = 3; // retries exhausted
    await runSchedulerCycle(registryOf(wa));
    expect(postRow(id).status).toBe("failed");
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("a successful post puts the credential status back to valid", async () => {
    tables.social_accounts = [account("waF8", { byok_status: "out_of_credit" })];
    const wa = adapterOf("whatsapp", () => ok);
    addPost("waF8");
    await runSchedulerCycle(registryOf(wa));
    expect(row("waF8").byok_status).toBe("valid");
  });
});

describe("a WhatsApp connection that does not hold the customer's own credentials", () => {
  it("is dropped cleanly: never sent, fixed reason, flagged for reconnect, no breaker, no ops notice", async () => {
    tables.social_accounts = [account("waG9", { credential_mode: "platform", byok_status: null })];
    const wa = adapterOf("whatsapp", () => ok);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push(addPost("waG9"));
      await runSchedulerCycle(registryOf(wa));
    }
    expect(wa.post).not.toHaveBeenCalled();
    for (const id of ids) {
      expect(postRow(id).status).toBe("failed");
      expect(postRow(id).retry_count).toBe(0);
    }
    expect(String(tables.post_results[0].error_message)).toBe(WHATSAPP_NOT_BYOK_MESSAGE);
    expect(tables.post_results[0].raw_error_message).toBe(WHATSAPP_BUNDLE_INVALID_CODE);
    expect(row("waG9").needs_reconnect_at).not.toBeNull();
    expect(notifyOps).not.toHaveBeenCalled();
  });
});

describe("non-byok behaviour of other platforms is unchanged", () => {
  const tg = () => account("tgH", { platform: "telegram", platform_account_id: "tg-h", credential_mode: "platform", byok_status: null });

  it("a telegram outage still trips the shared platform breaker after 5 failures and still tells ops once", async () => {
    tables.social_accounts = [tg()];
    const adapter = adapterOf("telegram", () => fail("Service Unavailable 503"));
    for (let i = 0; i < 6; i++) {
      addPost("tgH");
      await runSchedulerCycle(registryOf(adapter));
    }
    expect(adapter.post).toHaveBeenCalledTimes(5); // breaker opened on the fifth, the sixth was held back
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(String(notifyOps.mock.calls[0][0])).toContain('platform "telegram"');
  });

  it("a telegram post that fails for good still tells ops, and never touches byok_status", async () => {
    // The telegram breaker tripped in the test above (5 minute cooldown): move the clock past it.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 6 * MIN });
    tables.social_accounts = [tg()];
    const adapter = adapterOf("telegram", () => fail("Service Unavailable 503"));
    const id = addPost("tgH");
    postRow(id).retry_count = 3;
    await runSchedulerCycle(registryOf(adapter));
    expect(postRow(id).status).toBe("failed");
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(row("tgH").byok_status).toBeNull();
    vi.useRealTimers();
  });
});
