// The Pinterest blocked-link breaker (scheduler.ts, pauseAfterRepeatedBlockedLinks):
// after the second blocked-link failure in a row on one connected account, the
// account's other pending posts are paused (paused_at) and the customer is told
// once. supabase is an in-memory fake, nothing real is touched.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables } from "./testFakeSupabase.js";
import { PINTEREST_BLOCKED_LINK_MESSAGE } from "./postErrors.js";

// Lets a test make every read of one table fail, to prove the breaker fails safe.
let failReadsOn: string | null = null;
vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return {
    supabase: {
      from: (t: string) => {
        const b = f.makeBuilder(t) as Record<string, (...a: unknown[]) => unknown>;
        if (t !== failReadsOn) return b;
        const realSelect = b.select;
        b.select = (...a: unknown[]) => {
          const chain = realSelect(...a) as Record<string, unknown>;
          chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "boom" } }).then(resolve);
          return chain;
        };
        return b;
      },
      rpc: async () => ({ data: "token", error: null }),
    },
  };
});
vi.mock("./notify.js", () => ({ notifyOps: vi.fn(async () => {}) }));
const sendPinterestPausedAlert = vi.fn();
const sendFailureAlert = vi.fn();
vi.mock("./email.js", () => ({
  sendFailureAlert: (...a: unknown[]) => sendFailureAlert(...a),
  sendAccountPausedAlert: vi.fn(),
  sendPinterestPausedAlert: (...a: unknown[]) => sendPinterestPausedAlert(...a),
  sendReconnectNeededEmail: vi.fn(),
}));
vi.mock("./webhook.js", () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }));

const { runSchedulerCycle } = await import("./scheduler.js");

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const RAW = "Sorry! We blocked this link because it may lead to spam.";
let n = 0;

function post(over: Record<string, unknown> = {}) {
  n += 1;
  const row = { id: `p${n}`, account_id: "acc1", social_account_id: "sa1", content: "hello", media_url: null, retry_count: 0, status: "pending", paused_at: null, scheduled_for: new Date(Date.now() + DAY).toISOString(), updated_at: new Date().toISOString(), ...over };
  tables.scheduled_posts.push(row);
  return row;
}
/** An earlier finished post and the result row that went with it. */
function earlier(status: "posted" | "failed", agoMs: number, error: "blocked" | "other" | null) {
  const at = new Date(Date.now() - agoMs).toISOString();
  const row = post({ status, updated_at: at, scheduled_for: at });
  tables.post_results.push({
    id: `r${row.id}`,
    scheduled_post_id: row.id,
    account_id: "acc1",
    error_message: error === "blocked" ? PINTEREST_BLOCKED_LINK_MESSAGE : error === "other" ? "Pinterest could not read the image" : null,
    raw_error_message: error === "blocked" ? RAW : null,
    created_at: at,
  });
  return row;
}
/** The post that is due now and will fail with Pinterest's blocked-link rejection. */
function dueBlockedPost() {
  return post({ scheduled_for: new Date(Date.now() - MIN).toISOString() });
}
const pinterest = (message = RAW) => ({
  platform: "pinterest",
  post: vi.fn(async () => ({ success: false, platformPostId: null, errorMessage: message })),
  verifyPublished: vi.fn(),
});
const registryOf = (a: { platform: string }) => ({ get: (p: string) => (p === a.platform ? a : undefined) }) as never;

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  failReadsOn = null;
  sendPinterestPausedAlert.mockClear();
  sendFailureAlert.mockClear();
  tables.social_accounts = [
    { id: "sa1", account_id: "acc1", platform: "pinterest", display_name: "Mine", paused_at: null, access_token_vault_id: "v1", refresh_token_vault_id: null, token_expires_at: null, needs_reconnect_at: null, reconnect_notified_at: null },
    { id: "sa2", account_id: "acc1", platform: "pinterest", display_name: "Other board", paused_at: null, access_token_vault_id: "v2", refresh_token_vault_id: null, token_expires_at: null, needs_reconnect_at: null, reconnect_notified_at: null },
  ];
  tables.accounts = [{ id: "acc1", email: "jane.doe@acme-studio.co", email_failure_alerts_enabled: true, show_branding_tag: false }];
  tables.scheduled_posts = [];
  tables.post_results = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("Pinterest blocked-link breaker", () => {
  it("does not trigger on the first blocked-link failure", async () => {
    dueBlockedPost();
    const waiting = post();
    await runSchedulerCycle(registryOf(pinterest()));
    expect(waiting.status).toBe("pending");
    expect(waiting.paused_at).toBeNull();
    expect(sendPinterestPausedAlert).not.toHaveBeenCalled();
  });

  it("pauses the account's other pending posts on the second blocked-link failure in a row, and tells the customer once", async () => {
    earlier("failed", 2 * 60 * MIN, "blocked");
    dueBlockedPost();
    const waitingA = post();
    const waitingB = post();
    await runSchedulerCycle(registryOf(pinterest()));

    expect(waitingA.paused_at).toBeTruthy();
    expect(waitingB.paused_at).toBeTruthy();
    // Paused, not changed: still pending, content untouched, nothing deleted or marked posted.
    expect(waitingA.status).toBe("pending");
    expect(waitingA.content).toBe("hello");
    expect(tables.scheduled_posts.filter((p) => p.status === "posted")).toHaveLength(0);
    expect(tables.scheduled_posts).toHaveLength(4);
    expect(sendPinterestPausedAlert).toHaveBeenCalledTimes(1);
    expect(sendPinterestPausedAlert).toHaveBeenCalledWith("jane.doe@acme-studio.co");
    expect(sendFailureAlert).toHaveBeenCalledTimes(1); // the usual per-post failure alert is untouched
  });

  it("recognizes older rows that only kept Pinterest's raw text", async () => {
    const old = earlier("failed", 2 * 60 * MIN, null);
    tables.post_results.push({ id: "legacy", scheduled_post_id: old.id, account_id: "acc1", error_message: "x", raw_error_message: RAW, created_at: new Date().toISOString() });
    dueBlockedPost();
    const waiting = post();
    await runSchedulerCycle(registryOf(pinterest()));
    expect(waiting.paused_at).toBeTruthy();
  });

  it("does not trigger when a success came in between", async () => {
    earlier("failed", 3 * 60 * MIN, "blocked");
    earlier("posted", 2 * 60 * MIN, null);
    dueBlockedPost();
    const waiting = post();
    await runSchedulerCycle(registryOf(pinterest()));
    expect(waiting.paused_at).toBeNull();
    expect(sendPinterestPausedAlert).not.toHaveBeenCalled();
  });

  it("does not trigger when the other recent failure was something else", async () => {
    earlier("failed", 2 * 60 * MIN, "other");
    dueBlockedPost();
    const waiting = post();
    await runSchedulerCycle(registryOf(pinterest()));
    expect(waiting.paused_at).toBeNull();
  });

  it("ignores blocked failures older than 14 days", async () => {
    earlier("failed", 15 * DAY, "blocked");
    dueBlockedPost();
    const waiting = post();
    await runSchedulerCycle(registryOf(pinterest()));
    expect(waiting.paused_at).toBeNull();
  });

  it("pauses only that social account's pending posts", async () => {
    earlier("failed", 2 * 60 * MIN, "blocked");
    dueBlockedPost();
    const mine = post();
    const otherAccount = post({ social_account_id: "sa2" });
    const alreadyPaused = post({ paused_at: "2026-01-01T00:00:00.000Z" });
    const needsApproval = post({ status: "needs_approval" });
    await runSchedulerCycle(registryOf(pinterest()));
    expect(mine.paused_at).toBeTruthy();
    expect(otherAccount.paused_at).toBeNull();
    expect(alreadyPaused.paused_at).toBe("2026-01-01T00:00:00.000Z"); // not re-stamped
    expect(needsApproval.paused_at).toBeNull();
  });

  it("is idempotent: with nothing left pending there is no second pause and no second email", async () => {
    earlier("failed", 3 * 60 * MIN, "blocked");
    dueBlockedPost();
    const waiting = post();
    await runSchedulerCycle(registryOf(pinterest()));
    expect(sendPinterestPausedAlert).toHaveBeenCalledTimes(1);
    const stamp = waiting.paused_at;

    // Another blocked post fails; everything else is already paused.
    dueBlockedPost();
    await runSchedulerCycle(registryOf(pinterest()));
    expect(waiting.paused_at).toBe(stamp);
    expect(sendPinterestPausedAlert).toHaveBeenCalledTimes(1);
  });

  it("respects the failure-alert email setting but still pauses", async () => {
    tables.accounts[0].email_failure_alerts_enabled = false;
    earlier("failed", 2 * 60 * MIN, "blocked");
    dueBlockedPost();
    const waiting = post();
    await runSchedulerCycle(registryOf(pinterest()));
    expect(waiting.paused_at).toBeTruthy();
    expect(sendPinterestPausedAlert).not.toHaveBeenCalled();
  });

  it("fails safe: a lookup error is logged and nothing is paused", async () => {
    earlier("failed", 2 * 60 * MIN, "blocked");
    dueBlockedPost();
    const waiting = post();
    failReadsOn = "post_results"; // the failure's own insert still works; only reads break
    await runSchedulerCycle(registryOf(pinterest()));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("blocked-link breaker check failed"), "boom");
    expect(waiting.paused_at).toBeNull();
    expect(waiting.status).toBe("pending");
    expect(sendPinterestPausedAlert).not.toHaveBeenCalled();
  });

  it("does not count toward the platform circuit breaker and never retries a blocked post", async () => {
    const adapter = pinterest();
    for (let i = 0; i < 7; i++) {
      tables.scheduled_posts = tables.scheduled_posts.filter((p) => p.status !== "pending");
      dueBlockedPost();
      await runSchedulerCycle(registryOf(adapter));
    }
    expect(adapter.post).toHaveBeenCalledTimes(7); // the breaker (5 in a row) never held one back
    expect(tables.scheduled_posts.every((p) => p.retry_count === 0)).toBe(true);
  });

  it("only applies to Pinterest's blocked-link failure", async () => {
    earlier("failed", 2 * 60 * MIN, "blocked");
    dueBlockedPost();
    const waiting = post();
    await runSchedulerCycle(registryOf(pinterest("Pinterest API error: unsupported media format")));
    expect(waiting.paused_at).toBeNull();
  });
});
