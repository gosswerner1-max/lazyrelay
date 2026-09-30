// Webhooks v2: which endpoints get which events, and the durable delivery with
// retries. supabase is an in-memory fake, fetch is stubbed, and the URL safety
// check is mocked, so nothing here touches a real database or network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { tables } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: null, error: null }) } };
});
let urlIsSafe = true;
vi.mock("./urlSafety.js", () => ({
  isSafeMediaUrl: vi.fn(async () => (urlIsSafe ? { safe: true, addresses: ["93.184.216.34"] } : { safe: false, reason: "must not point at a private, internal, or reserved address" })),
}));

const {
  WEBHOOK_EVENTS,
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  classifyResponse,
  nextRetryDelayMs,
  endpointMatches,
  signWebhookBody,
  attemptDelivery,
  dispatchWebhookEvent,
  runWebhookDeliveryCycle,
} = await import("./webhook.js");

const MIN = 60_000;
const SECRET = "s3cret";
let fetchMock: ReturnType<typeof vi.fn>;

function respond(status: number) {
  fetchMock.mockResolvedValueOnce({ status, ok: status >= 200 && status < 300 } as Response);
}

function seedEndpoint(over: Record<string, unknown> = {}) {
  tables.webhook_endpoints ??= [];
  tables.webhook_endpoints.push({ id: `ep${tables.webhook_endpoints.length + 1}`, account_id: "acc1", url: "https://hooks.example.org/in", secret: SECRET, events: [], social_account_ids: null, enabled: true, ...over });
}
const deliveries = () => tables.webhook_deliveries ?? [];

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  urlIsSafe = true;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the pieces", () => {
  it("has the four documented events", () => {
    expect([...WEBHOOK_EVENTS]).toEqual(["post.verified", "post.failed", "post.unconfirmed", "channel.needs_reconnect"]);
  });

  it("the signature is unchanged from v1: HMAC-SHA256 of the raw body, hex", () => {
    const json = JSON.stringify({ event: "post.verified", postId: "p1" });
    expect(signWebhookBody(SECRET, json)).toBe(createHmac("sha256", SECRET).update(json).digest("hex"));
  });

  it.each([
    [200, "delivered"], [204, "delivered"],
    [408, "retry"], [429, "retry"], [500, "retry"], [503, "retry"],
    [301, "permanent"], [302, "permanent"], [400, "permanent"], [404, "permanent"], [410, "permanent"],
  ])("HTTP %s -> %s", (status, verdict) => {
    expect(classifyResponse(status)).toBe(verdict);
  });

  it("retries after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, then gives up (6 attempts)", () => {
    expect([...RETRY_DELAYS_MS]).toEqual([1 * MIN, 5 * MIN, 30 * MIN, 120 * MIN, 360 * MIN]);
    expect(MAX_ATTEMPTS).toBe(6);
    expect(nextRetryDelayMs(1)).toBe(1 * MIN);
    expect(nextRetryDelayMs(5)).toBe(360 * MIN);
    expect(nextRetryDelayMs(6)).toBeNull();
  });
});

describe("endpointMatches", () => {
  it("an empty event list means every event", () => {
    expect(endpointMatches({ events: [], social_account_ids: null }, "post.failed")).toBe(true);
  });
  it("only the subscribed events are delivered", () => {
    const ep = { events: ["post.verified"], social_account_ids: null };
    expect(endpointMatches(ep, "post.verified")).toBe(true);
    expect(endpointMatches(ep, "post.failed")).toBe(false);
  });
  it("a channel filter only lets that channel's events through", () => {
    const ep = { events: [], social_account_ids: ["sa1"] };
    expect(endpointMatches(ep, "post.verified", "sa1")).toBe(true);
    expect(endpointMatches(ep, "post.verified", "sa2")).toBe(false);
  });
  it("an event that is not about a channel goes to every endpoint", () => {
    expect(endpointMatches({ events: [], social_account_ids: ["sa1"] }, "webhook.test", null)).toBe(true);
  });
});

describe("dispatchWebhookEvent", () => {
  it("delivers to matching, enabled endpoints only, and signs each request", async () => {
    seedEndpoint({ id: "all" });
    seedEndpoint({ id: "only-failed", events: ["post.failed"] });
    seedEndpoint({ id: "other-channel", social_account_ids: ["sa9"] });
    seedEndpoint({ id: "off", enabled: false });
    seedEndpoint({ id: "someone-else", account_id: "acc2" });
    respond(200);
    await dispatchWebhookEvent({ accountId: "acc1", event: "post.verified", socialAccountId: "sa1", data: { postId: "p1", platform: "pinterest" } });
    await vi.waitFor(() => expect(deliveries().every((d) => d.status === "delivered")).toBe(true));

    expect(deliveries().map((d) => d.endpoint_id)).toEqual(["all"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://hooks.example.org/in");
    const body = String(init.body);
    expect(JSON.parse(body)).toMatchObject({ event: "post.verified", postId: "p1", platform: "pinterest" });
    expect(JSON.parse(body).eventId).toBeTruthy();
    expect(init.headers["X-LazyRelay-Signature"]).toBe(signWebhookBody(SECRET, body));
    expect(init.headers["X-LazyRelay-Event"]).toBe("post.verified");
    expect(init.headers["X-LazyRelay-Delivery"]).toBe(JSON.parse(body).eventId);
    expect(init.headers["X-LazyRelay-Attempt"]).toBe("1");
    expect(init.redirect).toBe("manual");
  });

  it("does nothing when no endpoint wants the event", async () => {
    seedEndpoint({ events: ["post.failed"] });
    await dispatchWebhookEvent({ accountId: "acc1", event: "post.verified", socialAccountId: "sa1", data: {} });
    expect(deliveries()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws, even if the database does", async () => {
    Object.defineProperty(tables, "webhook_endpoints", { get() { throw new Error("db down"); }, configurable: true });
    try {
      await expect(dispatchWebhookEvent({ accountId: "acc1", event: "post.verified", data: {} })).resolves.toBeUndefined();
    } finally {
      delete (tables as Record<string, unknown>).webhook_endpoints;
    }
  });
});

describe("retries", () => {
  async function queue(over: Record<string, unknown> = {}) {
    seedEndpoint();
    tables.webhook_deliveries = [{ id: "d1", endpoint_id: "ep1", account_id: "acc1", event: "post.failed", event_id: "evt-1", payload: { event: "post.failed", eventId: "evt-1", postId: "p1" }, status: "pending", attempts: 0, next_attempt_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(), created_at: new Date().toISOString(), ...over }];
  }

  it("a 503 is scheduled for a retry in a minute, and the same delivery id is reused", async () => {
    await queue();
    respond(503);
    const before = Date.now();
    const r = await attemptDelivery("d1");
    expect(r).toMatchObject({ status: "retry", statusCode: 503 });
    expect(deliveries()[0].status).toBe("pending");
    expect(deliveries()[0].attempts).toBe(1);
    expect(deliveries()[0].last_status_code).toBe(503);
    const next = new Date(String(deliveries()[0].next_attempt_at)).getTime();
    expect(next).toBeGreaterThanOrEqual(before + 1 * MIN - 50);
    expect(next).toBeLessThan(before + 2 * MIN);

    respond(200);
    const cycle = await runWebhookDeliveryCycle(next + 1000);
    expect(cycle.attempted).toBe(1);
    const second = fetchMock.mock.calls[1] as [string, { headers: Record<string, string> }];
    expect(second[1].headers["X-LazyRelay-Attempt"]).toBe("2");
    expect(second[1].headers["X-LazyRelay-Delivery"]).toBe("evt-1"); // the same id, so the receiver can ignore a repeat
    expect(deliveries()[0].status).toBe("delivered");
    expect(deliveries()[0].attempts).toBe(2);
  });

  it("a network error is retried", async () => {
    await queue();
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await attemptDelivery("d1");
    expect(r?.status).toBe("retry");
    expect(String(deliveries()[0].last_error)).toMatch(/Could not reach the endpoint/);
    expect(deliveries()[0].status).toBe("pending");
  });

  it("gives up after the sixth attempt and says so", async () => {
    await queue({ attempts: 5 });
    respond(500);
    const r = await attemptDelivery("d1");
    expect(r?.status).toBe("retry");
    expect(deliveries()[0].status).toBe("failed");
    expect(String(deliveries()[0].last_error)).toMatch(/Gave up after 6 attempts/);
  });

  it("a 404 is permanent: no retries", async () => {
    await queue();
    respond(404);
    await attemptDelivery("d1");
    expect(deliveries()[0].status).toBe("failed");
    expect(deliveries()[0].attempts).toBe(1);
    expect(String(deliveries()[0].last_error)).toMatch(/404/);
    expect((await runWebhookDeliveryCycle(Date.now() + 10 * 60 * MIN)).attempted).toBe(0);
  });

  it("a Send test event is tried once and never queued for retries, and says attempt 1", async () => {
    await queue({ event: "webhook.test" });
    respond(503);
    await attemptDelivery("d1");
    const headers = (fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }])[1].headers;
    expect(headers["X-LazyRelay-Attempt"]).toBe("1");
    expect(deliveries()[0].status).toBe("failed");
    expect(deliveries()[0].attempts).toBe(1);
    expect(String(deliveries()[0].last_error)).not.toMatch(/Gave up/);
    expect((await runWebhookDeliveryCycle(Date.now() + 10 * 60 * MIN)).attempted).toBe(0);
  });

  it("a redirect is refused and not followed, and not retried", async () => {
    await queue();
    respond(302);
    await attemptDelivery("d1");
    expect(deliveries()[0].status).toBe("failed");
    expect(String(deliveries()[0].last_error)).toMatch(/redirect/i);
  });
});

describe("safety", () => {
  it("a URL that stopped being allowed since it was saved is not called", async () => {
    seedEndpoint();
    tables.webhook_deliveries = [{ id: "d1", endpoint_id: "ep1", account_id: "acc1", event: "post.failed", event_id: "e", payload: {}, status: "pending", attempts: 0, next_attempt_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(), created_at: new Date().toISOString() }];
    urlIsSafe = false;
    await attemptDelivery("d1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deliveries()[0].status).toBe("failed");
    expect(String(deliveries()[0].last_error)).toMatch(/no longer allowed/);
  });

  it("an endpoint that was removed or turned off is not called", async () => {
    seedEndpoint({ enabled: false });
    tables.webhook_deliveries = [{ id: "d1", endpoint_id: "ep1", account_id: "acc1", event: "post.failed", event_id: "e", payload: {}, status: "pending", attempts: 0, next_attempt_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(), created_at: new Date().toISOString() }];
    await attemptDelivery("d1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deliveries()[0].status).toBe("failed");
  });

  it("a delivery already being sent is never sent twice", async () => {
    seedEndpoint();
    tables.webhook_deliveries = [{ id: "d1", endpoint_id: "ep1", account_id: "acc1", event: "post.failed", event_id: "e", payload: {}, status: "sending", attempts: 0, next_attempt_at: new Date(0).toISOString(), updated_at: new Date().toISOString(), created_at: new Date().toISOString() }];
    expect(await attemptDelivery("d1")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("runWebhookDeliveryCycle housekeeping", () => {
  it("frees a delivery stranded in 'sending' by a restart, and deletes old finished ones only", async () => {
    seedEndpoint();
    const now = Date.now();
    const old = new Date(now - 15 * 24 * 60 * MIN).toISOString();
    tables.webhook_deliveries = [
      { id: "stuck", endpoint_id: "ep1", account_id: "acc1", event: "post.failed", event_id: "a", payload: {}, status: "sending", attempts: 1, next_attempt_at: old, updated_at: new Date(now - 10 * MIN).toISOString(), created_at: new Date(now - 20 * MIN).toISOString() },
      { id: "old-done", endpoint_id: "ep1", account_id: "acc1", event: "post.failed", event_id: "b", payload: {}, status: "delivered", attempts: 1, next_attempt_at: old, updated_at: old, created_at: old },
      { id: "old-pending", endpoint_id: "ep1", account_id: "acc1", event: "post.failed", event_id: "c", payload: {}, status: "pending", attempts: 2, next_attempt_at: new Date(now + 60 * MIN).toISOString(), updated_at: old, created_at: old },
      { id: "recent-done", endpoint_id: "ep1", account_id: "acc1", event: "post.failed", event_id: "d", payload: {}, status: "delivered", attempts: 1, next_attempt_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), created_at: new Date(now).toISOString() },
    ];
    respond(200);
    const r = await runWebhookDeliveryCycle(now);
    expect(r).toMatchObject({ reclaimed: 1, attempted: 1, purged: 1 });
    expect(deliveries().map((d) => d.id).sort()).toEqual(["old-pending", "recent-done", "stuck"]);
    expect(deliveries().find((d) => d.id === "stuck")?.status).toBe("delivered");
    expect(deliveries().find((d) => d.id === "old-pending")?.status).toBe("pending"); // not due yet, and never purged while unfinished
  });
});
