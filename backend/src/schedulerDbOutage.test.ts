// What the scheduler does when the database cannot answer (a 522 from the
// gateway). The rule under test: an unknown answer is never turned into a
// default. A failed "was it already published?" lookup must not read as "no",
// a failed subscription lookup must not read as "free", and a post must never
// be published a second time because a write was lost.
// supabase is an in-memory fake with failures injected per table and operation,
// so nothing here can reach a real database or platform.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { tables, type Row } from "./testFakeSupabase.js";

// "<table>" fails every operation on that table; "<table>:insert" only its inserts.
const failing = new Set<string>();
const OUTAGE = { data: null, error: { message: "<!DOCTYPE html><title>522: Connection timed out</title>" }, status: 522 };

function failingBuilder() {
  const proxy: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? (resolve: (v: unknown) => unknown) => Promise.resolve(OUTAGE).then(resolve) : proxy),
    apply: () => proxy,
  });
  return proxy;
}

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return {
    supabase: {
      from: (t: string) => {
        if (failing.has(t)) return failingBuilder();
        const real = f.makeBuilder(t) as Record<string, unknown>;
        if (failing.has(`${t}:insert`)) real.insert = () => failingBuilder();
        return real;
      },
      rpc: async () => ({ data: "token", error: null }),
    },
  };
});
const notifyOps = vi.fn(async (_m: string) => {});
vi.mock("./notify.js", () => ({ notifyOps: (m: string) => notifyOps(m) }));
vi.mock("./email.js", () => ({ sendFailureAlert: vi.fn(), sendAccountPausedAlert: vi.fn() }));
const dispatchWebhookEvent = vi.fn(async (_e: Record<string, unknown>) => {});
vi.mock("./webhook.js", () => ({ dispatchWebhookEvent: (e: Record<string, unknown>) => dispatchWebhookEvent(e) }));

const { runSchedulerCycle, recoverStuckPosts, findAcceptedPublish } = await import("./scheduler.js");
const { UpstreamUnavailableError } = await import("./db/upstream.js");

const MIN = 60_000;
let sweepClock = Date.now() + 400 * 24 * 60 * MIN;
const nextSweepTime = () => (sweepClock += 24 * 60 * MIN);

function seed(post: Row = {}) {
  tables.social_accounts = [{ id: "sa1", platform: "fakeplat", paused_at: null, access_token_vault_id: "v1", refresh_token_vault_id: null, token_expires_at: null }];
  tables.accounts = [{ id: "acc1", email: "c@example.com", email_failure_alerts_enabled: false, show_branding_tag: true }];
  tables.subscriptions = [{ account_id: "acc1", tier: "pro", status: "active" }];
  tables.scheduled_posts = [
    { id: "p1", account_id: "acc1", social_account_id: "sa1", content: "hello", media_url: null, retry_count: 0, status: "pending", paused_at: null, scheduled_for: new Date(Date.now() - MIN).toISOString(), updated_at: new Date().toISOString(), ...post },
  ];
  tables.post_results = [];
}

function makeAdapter(verifiedLive: boolean) {
  return {
    platform: "fakeplat",
    post: vi.fn(async () => ({ success: true, platformPostId: "plat-123" })),
    verifyPublished: vi.fn(async () => ({ verifiedLive, platformPostUrl: verifiedLive ? "https://x/p" : null, errorMessage: verifiedLive ? null : "not visible yet" })),
  };
}
const registryOf = (adapter: unknown) => ({ get: (p: string) => (p === "fakeplat" ? adapter : undefined) }) as never;

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  failing.clear();
  notifyOps.mockClear();
  dispatchWebhookEvent.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("findAcceptedPublish during an outage", () => {
  it("throws instead of answering 'never published'", async () => {
    seed();
    failing.add("post_results");
    await expect(findAcceptedPublish("p1")).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it("still answers null when the database really has no accepted row", async () => {
    seed();
    expect(await findAcceptedPublish("p1")).toBeNull();
  });
});

describe("a post claimed while the database is down", () => {
  it("is deferred, not published, when the 'already published?' lookup fails", async () => {
    seed();
    failing.add("post_results");
    const adapter = makeAdapter(true);
    await runSchedulerCycle(registryOf(adapter));
    expect(adapter.post).not.toHaveBeenCalled(); // no second copy
    const post = tables.scheduled_posts[0];
    expect(post.status).toBe("pending");
    expect(post.retry_count).toBe(0); // the outage did not use up one of the post's own retries
    expect(new Date(String(post.scheduled_for)).getTime()).toBeGreaterThan(Date.now() + 30_000); // pushed out, not retried into the same outage
  });

  it("is deferred when the subscription lookup fails, so a paying customer is not treated as free", async () => {
    seed();
    failing.add("subscriptions");
    const adapter = makeAdapter(true);
    await runSchedulerCycle(registryOf(adapter));
    expect(adapter.post).not.toHaveBeenCalled();
    expect(tables.scheduled_posts[0].status).toBe("pending");
    expect(tables.scheduled_posts[0].retry_count).toBe(0);
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("is deferred when the social account lookup fails (no 'failed' mark, no retry used)", async () => {
    seed();
    failing.add("social_accounts");
    const adapter = makeAdapter(true);
    await runSchedulerCycle(registryOf(adapter));
    expect(adapter.post).not.toHaveBeenCalled();
    expect(tables.scheduled_posts[0].status).toBe("pending");
    expect(tables.scheduled_posts[0].retry_count).toBe(0);
  });

  it("still publishes normally, as a paid customer with no branding tag, when the database is healthy", async () => {
    seed();
    const adapter = makeAdapter(true);
    await runSchedulerCycle(registryOf(adapter));
    expect(adapter.post).toHaveBeenCalledTimes(1);
    const sent = (adapter.post.mock.calls[0] as unknown as [{ content: string }])[0];
    expect(sent.content).toBe("hello"); // paid tier: no "scheduled via LazyRelay" tag appended
    expect(tables.scheduled_posts[0].status).toBe("posted");
  });
});

describe("the platform accepted the post but its result row cannot be saved", () => {
  it("retries the write, then alerts ops with the platform post id, and never publishes a second copy", async () => {
    seed();
    failing.add("post_results:insert");
    const adapter = makeAdapter(false); // verification does not confirm it live
    await runSchedulerCycle(registryOf(adapter));
    expect(adapter.post).toHaveBeenCalledTimes(1);
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(String(notifyOps.mock.calls[0][0])).toContain("plat-123");
    expect(String(notifyOps.mock.calls[0][0])).toMatch(/do not re-publish/i);
    // Not sent back to pending (nothing would then stop a second publish).
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "post.unconfirmed" }));

    // Even if something put it back in the queue, only a fresh cycle's lookup decides; the post is not pending.
    await runSchedulerCycle(registryOf(adapter));
    expect(adapter.post).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("a verified-live post whose row could not be saved is still marked posted, and ops is told", async () => {
    seed();
    failing.add("post_results:insert");
    const adapter = makeAdapter(true);
    await runSchedulerCycle(registryOf(adapter));
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(String(notifyOps.mock.calls[0][0])).toContain("plat-123");
  }, 15_000);
});

describe("the stuck-post sweep during an outage", () => {
  it("does not mark a post failed-unconfirmed on a lookup it could not make", async () => {
    const at = nextSweepTime();
    seed({ status: "posting", updated_at: new Date(at - 45 * MIN).toISOString() });
    failing.add("post_results");
    expect(await recoverStuckPosts(at)).toBe(0);
    expect(tables.scheduled_posts[0].status).toBe("posting"); // left for the next sweep
    expect(notifyOps).not.toHaveBeenCalled();
  });
});
