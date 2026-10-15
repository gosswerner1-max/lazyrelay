// WhatsApp sending is not built, so a post that reaches the scheduler aimed at a WhatsApp connection (written straight to
// the database, or a recurring row, around the creation guard) is failed once with the fixed message: the adapter is never
// called, nothing is retried, no breaker counts it, ops is not told, one webhook event is sent, and the row leaves the
// claim state for good. supabase is an in-memory fake and the adapters are stubs: nothing real is touched.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: "token", error: null }) } };
});
const notifyOps = vi.fn(async (_m: string) => {});
vi.mock("./notify.js", () => ({ notifyOps: (m: string) => notifyOps(m) }));
const sendFailureAlert = vi.fn();
const sendReconnectNeededEmail = vi.fn();
vi.mock("./email.js", () => ({ sendFailureAlert: (...a: unknown[]) => sendFailureAlert(...a), sendAccountPausedAlert: vi.fn(), sendPinterestPausedAlert: vi.fn(), sendReconnectNeededEmail: (...a: unknown[]) => sendReconnectNeededEmail(...a) }));
const dispatchWebhookEvent = vi.fn(async (_e: Record<string, unknown>) => {});
vi.mock("./webhook.js", () => ({ dispatchWebhookEvent: (e: Record<string, unknown>) => dispatchWebhookEvent(e) }));

const { runSchedulerCycle } = await import("./scheduler.js");
const { WHATSAPP_SEND_NOT_SUPPORTED_MESSAGE, WHATSAPP_SEND_NOT_SUPPORTED_CODE, whatsappSendingSupported, isWhatsappSendBlocked } = await import("./platforms/whatsapp/sendSupport.js");

const MIN = 60_000;
let n = 0;
let warnings: string[];

const waAccount = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  account_id: "acc1",
  platform: "whatsapp",
  platform_account_id: `wa-${id}`,
  display_name: id,
  paused_at: null,
  credential_mode: "byok",
  byok_status: "valid",
  access_token_vault_id: `v-${id}`,
  refresh_token_vault_id: null,
  token_expires_at: null,
  needs_reconnect_at: null,
  reconnect_notified_at: null,
  ...over,
});
const tgAccount = (id: string) => waAccount(id, { platform: "telegram", platform_account_id: `tg-${id}`, credential_mode: "platform", byok_status: null });
function addPost(socialAccountId: string, over: Record<string, unknown> = {}) {
  n += 1;
  tables.scheduled_posts.push({ id: `p${n}`, account_id: "acc1", social_account_id: socialAccountId, content: "hello", media_url: null, retry_count: 0, status: "pending", paused_at: null, scheduled_for: new Date(Date.now() - MIN).toISOString(), updated_at: new Date().toISOString(), ...over });
  return `p${n}`;
}
const adapterOf = (platform: string) => ({
  platform,
  post: vi.fn(async () => ({ success: true, platformPostId: "t1", errorMessage: null })),
  verifyPublished: vi.fn(async () => ({ verifiedLive: true, platformPostUrl: "https://example.test/post/t1", errorMessage: null })),
});
const postRow = (id: string) => tables.scheduled_posts.find((r) => r.id === id)!;
const row = (id: string) => tables.social_accounts.find((r) => r.id === id)!;

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.accounts = [{ id: "acc1", email: "jane.doe@acme-studio.co", email_failure_alerts_enabled: true, show_branding_tag: false }];
  tables.scheduled_posts = [];
  tables.post_results = [];
  notifyOps.mockClear();
  sendFailureAlert.mockClear();
  sendReconnectNeededEmail.mockClear();
  dispatchWebhookEvent.mockClear();
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...a) => void warnings.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("the switch", () => {
  it("sending is not supported today, and only the whatsapp platform is blocked", () => {
    expect(whatsappSendingSupported()).toBe(false);
    expect(isWhatsappSendBlocked("whatsapp")).toBe(true);
    for (const p of ["telegram", "x", "facebook", "tiktok", "", null, undefined]) expect(isWhatsappSendBlocked(p)).toBe(false);
  });

  it("the message is exactly the agreed text, with a plain hyphen", () => {
    expect(WHATSAPP_SEND_NOT_SUPPORTED_MESSAGE).toBe("Not supported yet - requires approved Meta template models");
    expect(WHATSAPP_SEND_NOT_SUPPORTED_CODE).toBe("whatsapp_send_not_supported");
  });
});

describe("a claimed post aimed at a WhatsApp connection", () => {
  it("is failed once with the fixed message: no adapter call, no retry, no ops notice, one webhook, and it leaves the claim state", async () => {
    tables.social_accounts = [waAccount("waA")];
    const wa = adapterOf("whatsapp");
    const registry = { get: vi.fn((p: string) => (p === "whatsapp" ? wa : undefined)) } as never;
    const id = addPost("waA");

    await runSchedulerCycle(registry);

    expect(wa.post).not.toHaveBeenCalled();
    expect(wa.verifyPublished).not.toHaveBeenCalled();
    expect(postRow(id).status).toBe("failed"); // not "posting" and not "pending": it cannot be claimed again
    expect(postRow(id).retry_count).toBe(0);
    expect(tables.post_results).toHaveLength(1);
    expect(tables.post_results[0]).toMatchObject({
      scheduled_post_id: id,
      verified_live: false,
      platform_post_id: null,
      error_message: WHATSAPP_SEND_NOT_SUPPORTED_MESSAGE,
      raw_error_message: WHATSAPP_SEND_NOT_SUPPORTED_CODE,
    });
    expect(notifyOps).not.toHaveBeenCalled();
    expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    expect(dispatchWebhookEvent.mock.calls[0][0]).toMatchObject({ accountId: "acc1", event: "post.failed", socialAccountId: "waA" });
    expect((dispatchWebhookEvent.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({ postId: id, platform: "whatsapp", reason: WHATSAPP_SEND_NOT_SUPPORTED_MESSAGE });
    // it is not a credential problem: nothing is flagged, nothing is marked invalid, no reconnect email
    expect(row("waA").needs_reconnect_at).toBeNull();
    expect(row("waA").byok_status).toBe("valid");
    expect(sendReconnectNeededEmail).not.toHaveBeenCalled();
    expect(sendFailureAlert).not.toHaveBeenCalled();
  });

  it("never loops: later cycles do not touch it again and send no second event or result", async () => {
    tables.social_accounts = [waAccount("waB")];
    const wa = adapterOf("whatsapp");
    const registry = { get: () => wa } as never;
    const id = addPost("waB");
    for (let i = 0; i < 4; i++) await runSchedulerCycle(registry);
    expect(postRow(id).status).toBe("failed");
    expect(tables.post_results).toHaveLength(1);
    expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    expect(wa.post).not.toHaveBeenCalled();
  });

  it("a big backlog (a recurring row's worth) causes no breaker, no ops notice, and one webhook each", async () => {
    tables.social_accounts = [waAccount("waC"), tgAccount("tgC")];
    const wa = adapterOf("whatsapp");
    const tg = adapterOf("telegram");
    const registry = { get: (p: string) => (p === "whatsapp" ? wa : p === "telegram" ? tg : undefined) } as never;
    const waIds = Array.from({ length: 8 }, () => addPost("waC"));
    await runSchedulerCycle(registry);
    await runSchedulerCycle(registry);
    for (const id of waIds) expect(postRow(id).status).toBe("failed");
    expect(dispatchWebhookEvent).toHaveBeenCalledTimes(8);
    expect(notifyOps).not.toHaveBeenCalled();
    expect(warnings.some((w) => w.includes("Circuit breaker"))).toBe(false);
    expect(wa.post).not.toHaveBeenCalled();
    // and a normal post on another platform, afterwards, goes out
    const tgPost = addPost("tgC");
    await runSchedulerCycle(registry);
    expect(postRow(tgPost).status).toBe("posted");
    expect(tg.post).toHaveBeenCalledTimes(1);
  });

  it("is failed even when the whatsapp platform has no adapter on this deploy (it is not left pending)", async () => {
    tables.social_accounts = [waAccount("waD")];
    const registry = { get: () => undefined } as never;
    const id = addPost("waD");
    await runSchedulerCycle(registry);
    expect(postRow(id).status).toBe("failed");
  });

  it("a paused-then-failed or already-moved row is not failed twice: the update only applies while the post is still claimed", async () => {
    tables.social_accounts = [waAccount("waE")];
    const wa = adapterOf("whatsapp");
    const registry = { get: () => wa } as never;
    const id = addPost("waE", { status: "failed" }); // not pending: never claimed
    await runSchedulerCycle(registry);
    expect(postRow(id).status).toBe("failed");
    expect(tables.post_results).toHaveLength(0);
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
  });
});
