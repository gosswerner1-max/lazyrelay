// The publish hooks through the REAL scheduler: observe-only and failure-safe. An empty registry changes nothing, a throwing or
// hanging handler never stops or meaningfully delays a publish, a handler cannot change the post payload, and the context holds only
// ids and metadata. supabase is an in-memory fake.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: "token", error: null }) } };
});
vi.mock("./notify.js", () => ({ notifyOps: async () => {} }));
vi.mock("./email.js", () => ({ sendFailureAlert: vi.fn(), sendAccountPausedAlert: vi.fn(), sendReconnectNeededEmail: vi.fn() }));
vi.mock("./webhook.js", () => ({ dispatchWebhookEvent: async () => {} }));

const { runSchedulerCycle } = await import("./scheduler.js");
const { registerPublishHook, resetPublishHooks, PUBLISH_HOOK_TIMEOUT_MS } = await import("./publishHooks.js");

const SCHEDULED_FOR = new Date(Date.now() - 60_000).toISOString();
let n = 0;
function setup(platform: string, over: Record<string, unknown> = {}) {
  n += 1;
  tables.social_accounts = [{ id: "sa1", account_id: "acc1", platform, display_name: "Acct", platform_account_id: "pa1", paused_at: null, access_token_vault_id: "v1", refresh_token_vault_id: null, token_expires_at: null, needs_reconnect_at: null, reconnect_notified_at: null }];
  tables.accounts = [{ id: "acc1", email: "a@b.co", email_failure_alerts_enabled: false, show_branding_tag: false }];
  tables.post_results = [];
  tables.scheduled_posts = [{ id: `p${n}`, account_id: "acc1", social_account_id: "sa1", content: "SECRET CAPTION TEXT", media_url: "https://cdn.example/secret.jpg", retry_count: 2, status: "pending", paused_at: null, scheduled_for: SCHEDULED_FOR, updated_at: new Date().toISOString(), ...over }];
  return `p${n}`;
}
const live = { verifiedLive: true, platformPostUrl: "https://x/p", errorMessage: null };
const adapterOf = (platform: string, verification: unknown = live) => ({
  platform,
  post: vi.fn(async (_req: Record<string, unknown>) => ({ success: true, platformPostId: "plat-1", errorMessage: null })),
  verifyPublished: vi.fn(async () => verification),
});
const registryOf = (a: { platform: string }) => ({ get: (p: string) => (p === a.platform ? a : undefined) }) as never;

let errors: unknown[][];
beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  resetPublishHooks();
  errors = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetPublishHooks();
});

async function baselineArgs(platform: string): Promise<Record<string, unknown>> {
  setup(platform);
  const a = adapterOf(platform);
  await runSchedulerCycle(registryOf(a));
  return a.post.mock.calls[0][0];
}

describe("no handlers registered (the production default)", () => {
  it("publishes exactly as before: the adapter gets the same arguments and the post is posted", async () => {
    setup("hookplat1");
    const a = adapterOf("hookplat1");
    await runSchedulerCycle(registryOf(a));
    expect(a.post).toHaveBeenCalledTimes(1);
    expect(a.post.mock.calls[0][0]).toMatchObject({ socialAccountId: "sa1", content: "SECRET CAPTION TEXT", mediaUrl: "https://cdn.example/secret.jpg", scheduledPostId: expect.any(String), accessToken: "token" });
    expect(tables.scheduled_posts[0].status).toBe("posted");
  });
});

describe("a failing handler", () => {
  it("does not stop the publish, and is logged", async () => {
    setup("hookplat2");
    registerPublishHook("before_publish", "explodes", () => {
      throw new Error("kaboom");
    });
    registerPublishHook("after_verify", "also explodes", async () => {
      throw new Error("kaboom2");
    });
    const a = adapterOf("hookplat2");
    await runSchedulerCycle(registryOf(a));
    expect(a.post).toHaveBeenCalledTimes(1);
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(errors).toContainEqual(["[publish-hook]", "before_publish", "explodes", "kaboom"]);
    expect(errors).toContainEqual(["[publish-hook]", "after_verify", "also explodes", "kaboom2"]);
  });
});

describe("a handler that never answers", () => {
  it("delays the publish by exactly the timeout at most, never more", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setup("hookplat3");
    for (let i = 0; i < 5; i++) registerPublishHook("before_publish", `hang${i}`, () => new Promise<void>(() => {}));
    const a = adapterOf("hookplat3");
    const cycle = runSchedulerCycle(registryOf(a));
    await vi.advanceTimersByTimeAsync(PUBLISH_HOOK_TIMEOUT_MS - 1);
    expect(a.post).not.toHaveBeenCalled(); // held while the handlers run
    await vi.advanceTimersByTimeAsync(1);
    await cycle;
    expect(a.post).toHaveBeenCalledTimes(1); // five hanging handlers cost one timeout in total
    expect(tables.scheduled_posts[0].status).toBe("posted");
  });
});

describe("observe only", () => {
  it("a handler that tries to change the context cannot change what the adapter receives", async () => {
    const plain = await baselineArgs("hookplat4a");
    resetPublishHooks();
    setup("hookplat4b");
    registerPublishHook("before_publish", "tamper", (c) => {
      (c as { postId: string }).postId = "hacked";
      (c as unknown as { content: string }).content = "injected";
    });
    registerPublishHook("after_verify", "tamper2", (c) => {
      (c as { verifiedLive: boolean }).verifiedLive = false;
    });
    const a = adapterOf("hookplat4b");
    await runSchedulerCycle(registryOf(a));
    const { scheduledPostId: _a, ...withHook } = a.post.mock.calls[0][0];
    const { scheduledPostId: _b, ...without } = plain;
    expect(withHook).toEqual(without);
    expect(tables.scheduled_posts[0].status).toBe("posted"); // verifiedLive tampering changed nothing
  });
});

describe("the context holds ids and metadata only", () => {
  it("before_publish and after_verify carry exactly the agreed keys, and no content, media or token", async () => {
    const id = setup("hookplat5");
    const seen: Array<{ point: string; ctx: Record<string, unknown> }> = [];
    registerPublishHook("before_publish", "spy1", (c) => void seen.push({ point: "before_publish", ctx: c as never }));
    registerPublishHook("after_verify", "spy2", (c) => void seen.push({ point: "after_verify", ctx: c as never }));
    const a = adapterOf("hookplat5");
    await runSchedulerCycle(registryOf(a));
    expect(seen.map((s) => s.point)).toEqual(["before_publish", "after_verify"]);
    const base = { postId: id, accountId: "acc1", socialAccountId: "sa1", platform: "hookplat5", scheduledFor: SCHEDULED_FOR, attempt: 3 };
    expect(seen[0].ctx).toEqual(base);
    expect(seen[1].ctx).toEqual({ ...base, verifiedLive: true, platformPostId: "plat-1" });
    expect(Object.keys(seen[0].ctx).sort()).toEqual(["accountId", "attempt", "platform", "postId", "scheduledFor", "socialAccountId"]);
    expect(Object.keys(seen[1].ctx).sort()).toEqual(["accountId", "attempt", "platform", "platformPostId", "postId", "scheduledFor", "socialAccountId", "verifiedLive"]);
    const blob = JSON.stringify(seen);
    expect(blob).not.toMatch(/SECRET CAPTION|secret\.jpg|token|credential|vault/i);
  });

  it("after_verify also fires when the post could not be verified live", async () => {
    setup("hookplat6");
    const seen: Array<Record<string, unknown>> = [];
    registerPublishHook("after_verify", "spy", (c) => void seen.push(c as never));
    const a = adapterOf("hookplat6", { verifiedLive: false, platformPostUrl: null, errorMessage: "not live yet" });
    await runSchedulerCycle(registryOf(a));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ verifiedLive: false, platformPostId: "plat-1" });
  });

  it("before_publish does not fire when the platform already accepted this post (it is only re-verified)", async () => {
    const id = setup("hookplat7");
    tables.post_results = [{ id: "r1", scheduled_post_id: id, account_id: "acc1", platform_post_id: "plat-old", verified_live: false, created_at: new Date().toISOString() }];
    const before = vi.fn();
    registerPublishHook("before_publish", "spy", before);
    const a = adapterOf("hookplat7");
    await runSchedulerCycle(registryOf(a));
    expect(a.post).not.toHaveBeenCalled();
    expect(before).not.toHaveBeenCalled();
  });
});
