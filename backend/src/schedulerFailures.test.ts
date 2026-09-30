// Scheduler behavior for classified failures (postErrors.ts): fatal and
// reconnect errors fail at once with a plain-language reason, transient ones
// keep retrying, and only errors that reflect platform health count toward the
// circuit breaker. supabase is an in-memory fake, nothing real is touched.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: "token", error: null }) } };
});
const notifyOps = vi.fn(async (_m: string) => {});
vi.mock("./notify.js", () => ({ notifyOps: (m: string) => notifyOps(m) }));
const sendReconnectNeededEmail = vi.fn();
vi.mock("./email.js", () => ({ sendFailureAlert: vi.fn(), sendAccountPausedAlert: vi.fn(), sendReconnectNeededEmail: (...a: unknown[]) => sendReconnectNeededEmail(...a) }));
const dispatchWebhookEvent = vi.fn(async (_e: Record<string, unknown>) => {});
vi.mock("./webhook.js", () => ({ dispatchWebhookEvent: (e: Record<string, unknown>) => dispatchWebhookEvent(e) }));

const { runSchedulerCycle } = await import("./scheduler.js");

const MIN = 60_000;
let n = 0;

// Each test uses its own platform name so the module-level circuit breaker
// and rate limiter never leak between tests.
function setup(platform: string, over: Record<string, unknown> = {}) {
  tables.social_accounts = [{ id: "sa1", account_id: "acc1", platform, display_name: "My Account", paused_at: null, access_token_vault_id: "v1", refresh_token_vault_id: null, token_expires_at: null, needs_reconnect_at: null, reconnect_notified_at: null }];
  tables.accounts = [{ id: "acc1", email: "jane.doe@acme-studio.co", email_failure_alerts_enabled: false, show_branding_tag: false }];
  tables.scheduled_posts = [];
  tables.post_results = [];
  addPost(over);
}
function addPost(over: Record<string, unknown> = {}) {
  n += 1;
  tables.scheduled_posts.push({ id: `p${n}`, account_id: "acc1", social_account_id: "sa1", content: "hello", media_url: null, retry_count: 0, status: "pending", paused_at: null, scheduled_for: new Date(Date.now() - MIN).toISOString(), updated_at: new Date().toISOString(), ...over });
}
const adapterOf = (platform: string, post: () => unknown, verify?: () => unknown) => ({
  platform,
  post: vi.fn(async () => post()),
  verifyPublished: vi.fn(async () => (verify ? verify() : { verifiedLive: true, platformPostUrl: "https://x/p", errorMessage: null })),
});
const registryOf = (a: { platform: string }) => ({ get: (p: string) => (p === a.platform ? a : undefined) }) as never;
const fail = (msg: string) => ({ success: false, platformPostId: null, errorMessage: msg });

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  notifyOps.mockClear();
  dispatchWebhookEvent.mockClear();
  sendReconnectNeededEmail.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("fatal errors fail at once, with a plain-language reason", () => {
  it("a blocked link is not retried, and the customer sees why (the real Pinterest case)", async () => {
    setup("pinterest");
    const adapter = adapterOf("pinterest", () => fail("Sorry! We blocked this link because it may lead to spam."));
    await runSchedulerCycle(registryOf(adapter));

    expect(adapter.post).toHaveBeenCalledTimes(1);
    expect(tables.scheduled_posts[0].status).toBe("failed"); // straight to failed, no backoff
    expect(tables.scheduled_posts[0].retry_count).toBe(0);
    expect(String(tables.post_results[0].error_message)).toMatch(/^Pinterest blocked the link/);
    expect(String(tables.post_results[0].error_message)).toMatch(/Pinterest decision about the website address/);
    expect(String(tables.post_results[0].error_message)).toMatch(/Help Center/);
    expect(String(tables.post_results[0].error_message)).not.toMatch(/different (destination )?link|shortener|redirect/i);
    expect(tables.post_results[0].raw_error_message).toBe("Sorry! We blocked this link because it may lead to spam.");

    await runSchedulerCycle(registryOf(adapter)); // nothing left to retry
    expect(adapter.post).toHaveBeenCalledTimes(1);
  });

  it("customer-specific rejections never trip the platform circuit breaker", async () => {
    setup("fatalplat");
    // The breaker trips at 5 consecutive failures; use a rule that applies to any platform.
    const generic = adapterOf("fatalplat", () => fail("Content is a duplicate of a recent post"));
    for (let i = 0; i < 7; i++) {
      tables.scheduled_posts = [];
      addPost();
      await runSchedulerCycle(registryOf(generic));
    }
    expect(generic.post).toHaveBeenCalledTimes(7); // the 6th and 7th were still attempted
  });
});

describe("transient errors keep retrying", () => {
  it("a rate limit goes back to pending with a backoff and a friendly reason", async () => {
    setup("ratelimited");
    const adapter = adapterOf("ratelimited", () => fail("Too many requests, slow down"));
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("pending");
    expect(tables.scheduled_posts[0].retry_count).toBe(1);
    expect(String(tables.post_results[0].error_message)).toMatch(/limiting requests/);
  });

  it("transient failures still count toward the breaker (5 in a row pause the platform)", async () => {
    setup("flaky");
    const adapter = adapterOf("flaky", () => fail("Service unavailable"));
    for (let i = 0; i < 6; i++) {
      tables.scheduled_posts = [];
      addPost();
      await runSchedulerCycle(registryOf(adapter));
    }
    expect(adapter.post).toHaveBeenCalledTimes(5); // the 6th was held back by the breaker
  });

  it("an unknown error behaves exactly as before: retry, raw text shown", async () => {
    setup("mystery");
    const adapter = adapterOf("mystery", () => fail("Something nobody has seen before"));
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("pending");
    expect(tables.post_results[0].error_message).toBe("Something nobody has seen before");
    expect(tables.post_results[0].raw_error_message).toBeNull(); // unknown: the dashboard translates it
  });

  it("the verification lag after a real publish is retried without publishing twice", async () => {
    setup("laggy");
    const adapter = adapterOf(
      "laggy",
      () => ({ success: true, platformPostId: "plat-1", errorMessage: null }),
      () => ({ verifiedLive: false, platformPostUrl: null, errorMessage: "The requested resource does not exist" }),
    );
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("pending");
    expect(String(tables.post_results[0].error_message)).toMatch(/re-checking it and will not post it twice/);
    expect(tables.post_results[0].raw_error_message).toBe("The requested resource does not exist");
  });
});

describe("a dead login", () => {
  it("fails at once, flags the account for reconnect and tells the customer once", async () => {
    setup("bluesky");
    const adapter = adapterOf("bluesky", () => fail("Token has expired"));
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(adapter.post).toHaveBeenCalledTimes(1);
    expect(String(tables.post_results[0].error_message)).toMatch(/Your Bluesky connection has expired/);
    expect(tables.social_accounts[0].needs_reconnect_at).toBeTruthy();
    expect(sendReconnectNeededEmail).toHaveBeenCalledTimes(1);
  });
});

describe("our own credentials are never blamed on the customer", () => {
  it("invalid_client is retried and never flags the account or emails the customer", async () => {
    setup("tiktok");
    const adapter = adapterOf("tiktok", () => fail("Client key or secret is incorrect."));
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("pending");
    expect(tables.social_accounts[0].needs_reconnect_at).toBeNull();
    expect(sendReconnectNeededEmail).not.toHaveBeenCalled();
    expect(String(tables.post_results[0].error_message)).toMatch(/We have been alerted/);
  });
});

describe("webhook events", () => {
  it("a fatal failure raises post.failed with the plain-language reason", async () => {
    setup("pinterest");
    const adapter = adapterOf("pinterest", () => fail("Sorry! We blocked this link because it may lead to spam."));
    await runSchedulerCycle(registryOf(adapter));
    expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    const call = dispatchWebhookEvent.mock.calls[0][0] as { accountId: string; event: string; socialAccountId: string; data: Record<string, unknown> };
    expect(call).toMatchObject({ accountId: "acc1", event: "post.failed", socialAccountId: "sa1" });
    expect(String(call.data.reason)).toMatch(/Pinterest decision about the website address/);
    expect(call.data).toMatchObject({ postId: "p" + n, platform: "pinterest", reasonKind: "fatal" });
  });

  it("a failure that will be retried raises nothing yet", async () => {
    setup("retrywebhook");
    const adapter = adapterOf("retrywebhook", () => fail("Too many requests, slow down"));
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("pending");
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("running out of retries with nothing accepted raises post.failed", async () => {
    setup("exhausted1", { retry_count: 3 });
    const adapter = adapterOf("exhausted1", () => fail("Service unavailable"));
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "post.failed", data: expect.objectContaining({ reasonKind: "retries_exhausted" }) }));
  });

  it("running out of retries after the platform DID accept it raises post.unconfirmed, never post.failed", async () => {
    setup("exhausted2", { retry_count: 3 });
    tables.post_results = [{ id: "r1", scheduled_post_id: "p" + n, platform_post_id: "plat-77", verified_live: false, created_at: new Date().toISOString() }];
    const adapter = adapterOf(
      "exhausted2",
      () => ({ success: true, platformPostId: "plat-77", errorMessage: null }),
      () => ({ verifiedLive: false, platformPostUrl: null, errorMessage: "The requested resource does not exist" }),
    );
    await runSchedulerCycle(registryOf(adapter));
    expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "post.unconfirmed", data: expect.objectContaining({ platformPostId: "plat-77" }) }),
    );
  });

  it("a verified post raises post.verified once, with its link", async () => {
    setup("happy");
    const adapter = adapterOf("happy", () => ({ success: true, platformPostId: "plat-1", errorMessage: null }));
    await runSchedulerCycle(registryOf(adapter));
    expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "post.verified", socialAccountId: "sa1", data: expect.objectContaining({ platformPostUrl: "https://x/p", platform: "happy" }) }),
    );
  });

  it("a dead login raises post.failed, and the channel event fires once", async () => {
    setup("bluesky");
    const adapter = adapterOf("bluesky", () => fail("Token has expired"));
    await runSchedulerCycle(registryOf(adapter));
    const events = dispatchWebhookEvent.mock.calls.map((c) => (c[0] as { event: string }).event).sort();
    expect(events).toEqual(["channel.needs_reconnect", "post.failed"]);
  });
});

describe("the connected account id reaches the adapter", () => {
  it("passes the stored platform account id (a Tumblr blog) to adapter.post", async () => {
    setup("blogplat");
    tables.social_accounts[0].platform_account_id = "side-project";
    const adapter = adapterOf("blogplat", () => ({ success: true, platformPostId: "plat-1", errorMessage: null }));
    await runSchedulerCycle(registryOf(adapter));
    expect(adapter.post).toHaveBeenCalledWith(expect.objectContaining({ platformAccountId: "side-project" }));
  });
});
