// Behavior tests for two scheduler reliability fixes:
//  1. A post the platform already accepted, but that verification couldn't
//     confirm live, is re-verified on retry -- never published a second time.
//  2. A post stranded in "posting" (crash/restart mid-publish) is recovered:
//     re-verified if the platform returned an id, otherwise failed as
//     "unconfirmed" and alerted, never silently re-posted.
// supabase is replaced with a small in-memory table engine, so nothing here
// can reach a real database or platform.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { tables, type Row } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: "token", error: null }) } };
});
const notifyOps = vi.fn(async () => {});
vi.mock("./notify.js", () => ({ notifyOps: (...a: unknown[]) => notifyOps(...(a as [])) }));
vi.mock("./email.js", () => ({ sendFailureAlert: vi.fn(), sendAccountPausedAlert: vi.fn() }));
const dispatchWebhookEvent = vi.fn(async (_e: Record<string, unknown>) => {});
vi.mock("./webhook.js", () => ({ dispatchWebhookEvent: (e: Record<string, unknown>) => dispatchWebhookEvent(e) }));

const { runSchedulerCycle, recoverStuckPosts, findAcceptedPublish } = await import("./scheduler.js");

const MIN = 60_000;
let sweepClock = Date.now();
const nextSweepTime = () => (sweepClock += 24 * 60 * MIN);

function seed(post: Row = {}) {
  tables.social_accounts = [{ id: "sa1", platform: "fakeplat", paused_at: null, access_token_vault_id: "v1", refresh_token_vault_id: null, token_expires_at: null }];
  tables.accounts = [{ id: "acc1", email: "c@example.com", email_failure_alerts_enabled: false, show_branding_tag: false }];
  tables.scheduled_posts = [
    { id: "p1", account_id: "acc1", social_account_id: "sa1", content: "hello", media_url: null, retry_count: 0, status: "pending", paused_at: null, scheduled_for: new Date(Date.now() - MIN).toISOString(), updated_at: new Date().toISOString(), ...post },
  ];
  tables.post_results = [];
}

function makeAdapter(verify: Array<{ verifiedLive: boolean }>) {
  let v = 0;
  return {
    platform: "fakeplat",
    post: vi.fn(async () => ({ success: true, platformPostId: "plat-123" })),
    verifyPublished: vi.fn(async () => {
      const r = verify[Math.min(v++, verify.length - 1)];
      return { verifiedLive: r.verifiedLive, platformPostUrl: r.verifiedLive ? "https://x/p" : null, errorMessage: r.verifiedLive ? null : "not visible yet" };
    }),
  };
}
const registryOf = (adapter: unknown) => ({ get: (p: string) => (p === "fakeplat" ? adapter : undefined) }) as never;

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  notifyOps.mockClear();
  dispatchWebhookEvent.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("retry after a failed verification never publishes twice", () => {
  it("re-verifies the existing platform post on the retry and marks it posted", async () => {
    seed();
    const adapter = makeAdapter([{ verifiedLive: false }, { verifiedLive: true }]);

    await runSchedulerCycle(registryOf(adapter));
    expect(adapter.post).toHaveBeenCalledTimes(1);
    expect(tables.scheduled_posts[0].status).toBe("pending"); // reset for retry
    expect(tables.post_results).toHaveLength(1);
    expect(tables.post_results[0].platform_post_id).toBe("plat-123");

    // Backoff elapsed: make it due again and run the retry.
    tables.scheduled_posts[0].scheduled_for = new Date(Date.now() - MIN).toISOString();
    await runSchedulerCycle(registryOf(adapter));

    expect(adapter.post).toHaveBeenCalledTimes(1); // NOT published a second time
    expect(adapter.verifyPublished).toHaveBeenCalledTimes(2);
    expect(adapter.verifyPublished).toHaveBeenLastCalledWith("plat-123", "token");
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(tables.post_results).toHaveLength(1); // updated in place, one proof row
    expect(tables.post_results[0].verified_live).toBe(true);
  });

  it("still publishes normally when no earlier attempt was accepted", async () => {
    seed();
    const adapter = makeAdapter([{ verifiedLive: true }]);
    await runSchedulerCycle(registryOf(adapter));
    expect(adapter.post).toHaveBeenCalledTimes(1);
    expect(tables.scheduled_posts[0].status).toBe("posted");
  });

  it("a post that failed before the platform accepted it is still published again", async () => {
    seed();
    tables.post_results = [{ id: "r0", scheduled_post_id: "p1", platform_post_id: null, verified_live: false, created_at: new Date().toISOString() }];
    const adapter = makeAdapter([{ verifiedLive: true }]);
    await runSchedulerCycle(registryOf(adapter));
    expect(adapter.post).toHaveBeenCalledTimes(1);
  });

  it("findAcceptedPublish ignores rows with no platform id", async () => {
    seed();
    tables.post_results = [{ id: "r0", scheduled_post_id: "p1", platform_post_id: null, created_at: "2026-01-01T00:00:00Z" }];
    expect(await findAcceptedPublish("p1")).toBeNull();
    tables.post_results.push({ id: "r1", scheduled_post_id: "p1", platform_post_id: "abc", created_at: "2026-01-02T00:00:00Z" });
    expect(await findAcceptedPublish("p1")).toEqual({ id: "r1", platform_post_id: "abc" });
  });
});

describe("recoverStuckPosts", () => {
  // Timestamps are relative to the sweep time passed in, not the wall clock.
  let sweepAt = 0;
  const startSweep = () => (sweepAt = nextSweepTime());
  const stale = () => new Date(sweepAt - 45 * MIN).toISOString();

  it("returns a stuck post to pending when the platform already returned an id, without publishing", async () => {
    startSweep();
    seed({ status: "posting", updated_at: stale() });
    tables.post_results = [{ id: "r1", scheduled_post_id: "p1", platform_post_id: "plat-9", verified_live: false, created_at: new Date().toISOString() }];
    expect(await recoverStuckPosts(sweepAt)).toBe(1);
    expect(tables.scheduled_posts[0].status).toBe("pending");
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("fails a stuck post with no platform id as unconfirmed, records why, and alerts ops -- never re-posts", async () => {
    startSweep();
    seed({ status: "posting", updated_at: stale() });
    expect(await recoverStuckPosts(sweepAt)).toBe(1);
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(tables.post_results).toHaveLength(1);
    expect(String(tables.post_results[0].error_message)).toMatch(/interrupted/i);
    expect(String(tables.post_results[0].error_message)).toMatch(/check your account/i);
    expect(notifyOps).toHaveBeenCalledTimes(1);
  });

  it("an interrupted post with no platform id raises post.unconfirmed (never post.failed: it may be live)", async () => {
    startSweep();
    seed({ status: "posting", updated_at: stale() });
    await recoverStuckPosts(sweepAt);
    expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc1", event: "post.unconfirmed", data: expect.objectContaining({ postId: "p1", reasonKind: "interrupted" }) }),
    );
  });

  it("leaves a recently claimed post alone", async () => {
    startSweep();
    seed({ status: "posting", updated_at: new Date(sweepAt - MIN).toISOString() });
    expect(await recoverStuckPosts(sweepAt)).toBe(0);
    expect(tables.scheduled_posts[0].status).toBe("posting");
  });

  it("leaves posts in other states alone", async () => {
    startSweep();
    seed({ status: "pending", updated_at: stale() });
    expect(await recoverStuckPosts(sweepAt)).toBe(0);
    expect(tables.scheduled_posts[0].status).toBe("pending");
  });

  it("only sweeps once per interval", async () => {
    const t = startSweep();
    seed({ status: "posting", updated_at: stale() });
    expect(await recoverStuckPosts(t)).toBe(1);
    seed({ status: "posting", updated_at: stale() });
    expect(await recoverStuckPosts(t + 10_000)).toBe(0); // throttled
    expect(tables.scheduled_posts[0].status).toBe("posting");
  });
});
