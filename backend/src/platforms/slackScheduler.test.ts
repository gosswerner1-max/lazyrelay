// The real SlackAdapter driven by the real scheduler (supabase and Slack's API are stubs). Proves the
// proof-of-publish contract for Slack: a failed permalink check after a successful post is "unconfirmed", the retry
// re-checks and NEVER calls chat.postMessage again, and a dead login or a bad channel fails at once with a reason.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "../testFakeSupabase.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: "xoxb-test-placeholder-token", error: null }) } };
});
vi.mock("../notify.js", () => ({ notifyOps: vi.fn(async () => {}) }));
vi.mock("../email.js", () => ({ sendFailureAlert: vi.fn(), sendAccountPausedAlert: vi.fn(), sendPinterestPausedAlert: vi.fn(), sendReconnectNeededEmail: vi.fn() }));
vi.mock("../webhook.js", () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }));

const { runSchedulerCycle } = await import("../scheduler.js");
const { SlackAdapter } = await import("./slack.js");

const MIN = 60_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const registryOf = (adapter: unknown) => ({ get: (p: string) => (p === "slack" ? adapter : undefined) }) as never;
const PERMALINK = "https://acme.slack.com/archives/C0123/p1700000000000100";

let fetchMock: ReturnType<typeof vi.fn>;
const calls = (method: string) => fetchMock.mock.calls.filter((c) => String(c[0]).includes(`/api/${method}`));

function seed(platformAccountId = "T0001:C0123") {
  tables.social_accounts = [
    { id: "sa1", account_id: "acc1", platform: "slack", display_name: "#general (Acme)", platform_account_id: platformAccountId, paused_at: null, access_token_vault_id: "v1", refresh_token_vault_id: null, token_expires_at: null, needs_reconnect_at: null, reconnect_notified_at: null },
  ];
  tables.accounts = [{ id: "acc1", email: "jane.doe@acme-studio.co", email_failure_alerts_enabled: false, show_branding_tag: false }];
  tables.scheduled_posts = [
    { id: "p1", account_id: "acc1", social_account_id: "sa1", platform_account_id: platformAccountId, content: "Launch day <!channel>", media_url: null, retry_count: 0, status: "pending", paused_at: null, scheduled_for: new Date(Date.now() - MIN).toISOString(), updated_at: new Date().toISOString() },
  ];
  tables.post_results = [];
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("Slack through the scheduler", () => {
  it("posts to the connected channel, confirms it by permalink, and stores the permalink as the proof link", async () => {
    seed();
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("chat.postMessage") ? json({ ok: true, channel: "C0123", ts: "1700000000.000100" }) : json({ ok: true, permalink: PERMALINK }),
    );
    await runSchedulerCycle(registryOf(new SlackAdapter("id", "secret", "https://api.example.org/cb")));

    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(tables.post_results).toHaveLength(1);
    expect(tables.post_results[0]).toMatchObject({ platform_post_id: "C0123:1700000000.000100", platform_post_url: PERMALINK, verified_live: true });
    const sent = JSON.parse((calls("chat.postMessage")[0][1] as RequestInit).body as string);
    expect(sent.channel).toBe("C0123");
    expect(sent.text).toBe("Launch day &lt;!channel&gt;"); // the customer's text cannot ping the channel
  });

  it("a permalink that fails after a successful post is unconfirmed and the retry re-checks it without posting again", async () => {
    seed();
    let permalinkAttempts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("chat.postMessage")) return json({ ok: true, channel: "C0123", ts: "1700000000.000100" });
      permalinkAttempts += 1;
      return permalinkAttempts === 1 ? json({ ok: false, error: "message_not_found" }) : json({ ok: true, permalink: PERMALINK });
    });
    const adapter = new SlackAdapter("id", "secret", "https://api.example.org/cb");

    await runSchedulerCycle(registryOf(adapter));
    expect(calls("chat.postMessage")).toHaveLength(1);
    expect(tables.scheduled_posts[0].status).toBe("pending"); // reset for a retry, not failed
    expect(tables.post_results).toHaveLength(1);
    expect(tables.post_results[0]).toMatchObject({ platform_post_id: "C0123:1700000000.000100", verified_live: false });
    expect(String(tables.post_results[0].error_message)).toMatch(/will not post it twice/);

    tables.scheduled_posts[0].scheduled_for = new Date(Date.now() - MIN).toISOString();
    await runSchedulerCycle(registryOf(adapter));

    expect(calls("chat.postMessage")).toHaveLength(1); // NOT posted a second time
    expect(calls("chat.getPermalink")).toHaveLength(2);
    expect(tables.scheduled_posts[0].status).toBe("posted");
    expect(tables.post_results).toHaveLength(1); // the same proof row, updated
    expect(tables.post_results[0]).toMatchObject({ verified_live: true, platform_post_url: PERMALINK });
  });

  it("a dead bot token fails at once, flags the account for reconnect, and does not retry", async () => {
    seed();
    fetchMock.mockImplementation(async () => json({ ok: false, error: "token_revoked" }));
    await runSchedulerCycle(registryOf(new SlackAdapter("id", "secret", "https://api.example.org/cb")));
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(String(tables.post_results[0].error_message)).toMatch(/Reconnect it in Social Platforms/);
    expect(tables.social_accounts[0].needs_reconnect_at).toBeTruthy();
    expect(calls("chat.postMessage")).toHaveLength(1);
  });

  it("a private or deleted channel fails at once with words that tell the customer to invite the app", async () => {
    seed();
    fetchMock.mockImplementation(async () => json({ ok: false, error: "not_in_channel" }));
    await runSchedulerCycle(registryOf(new SlackAdapter("id", "secret", "https://api.example.org/cb")));
    expect(tables.scheduled_posts[0].status).toBe("failed");
    expect(String(tables.post_results[0].error_message)).toMatch(/invite the LazyRelay app/);
    expect(tables.post_results[0].raw_error_message).toMatch(/not_in_channel/);
  });

  it("a rate limit is retried later, not failed", async () => {
    seed();
    fetchMock.mockImplementation(async () => new Response("", { status: 429, headers: { "retry-after": "30" } }));
    await runSchedulerCycle(registryOf(new SlackAdapter("id", "secret", "https://api.example.org/cb")));
    expect(tables.scheduled_posts[0].status).toBe("pending");
    expect(tables.scheduled_posts[0].retry_count).toBe(1);
  });
});
