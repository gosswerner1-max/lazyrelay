// The webhook endpoint API: validation, per-account isolation, the 5-endpoint
// limit, one-time secrets and the test button. Login is mocked (the real auth
// is tested elsewhere); supabase is an in-memory fake, fetch is stubbed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables } from "../../testFakeSupabase.js";

const auth = vi.hoisted(() => ({ accountId: "acc1", role: "owner", method: "jwt" }));
vi.mock("../auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.accountId = auth.accountId;
    req.role = auth.role;
    req.authMethod = auth.method;
    next();
  },
  requireHumanAuth: (req: any, res: any, next: any) =>
    req.authMethod === "apiKey" ? res.status(403).json({ error: "dashboard session only" }) : next(),
  requireOwner: (req: any, res: any, next: any) =>
    req.role !== "owner" ? res.status(403).json({ error: "owner only" }) : next(),
}));
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_req: any, _res: any, next: any) => next() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: null, error: null }) } };
});
let urlIsSafe = true;
vi.mock("../../urlSafety.js", () => ({
  isSafeMediaUrl: vi.fn(async () => (urlIsSafe ? { safe: true, addresses: ["93.184.216.34"] } : { safe: false, reason: "must not point at a private, internal, or reserved address" })),
}));

const { buildWebhooksRouter } = await import("./webhooks.routes.js");
const { signWebhookBody } = await import("../../webhook.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use(buildWebhooksRouter());
  return a;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  auth.accountId = "acc1";
  auth.role = "owner";
  auth.method = "jwt";
  urlIsSafe = true;
  tables.social_accounts = [
    { id: "sa1", account_id: "acc1" },
    { id: "sa2", account_id: "acc1" },
    { id: "other-sa", account_id: "acc2" },
  ];
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const create = (body: Record<string, unknown>) => request(app()).post("/webhooks").send(body);

describe("POST /webhooks", () => {
  it("creates an endpoint, shows the secret once, and never again", async () => {
    const res = await create({ url: "https://hooks.example.org/in", label: "  Zapier  " });
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body).toMatchObject({ url: "https://hooks.example.org/in", label: "Zapier", events: [], socialAccountIds: null, enabled: true });

    const list = await request(app()).get("/webhooks");
    expect(list.status).toBe(200);
    expect(list.body.endpoints).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(res.body.secret);
    expect(list.body.maxEndpoints).toBe(5);
    expect(list.body.availableEvents).toEqual(["post.verified", "post.failed", "post.unconfirmed", "channel.needs_reconnect"]);
  });

  it("accepts a choice of events and channels", async () => {
    const res = await create({ url: "https://hooks.example.org/in", events: ["post.failed"], socialAccountIds: ["sa1"] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ events: ["post.failed"], socialAccountIds: ["sa1"] });
  });

  it("refuses an address that is private or internal", async () => {
    urlIsSafe = false;
    const res = await create({ url: "https://internal.example.org/x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/private, internal, or reserved/);
    expect(tables.webhook_endpoints ?? []).toHaveLength(0);
  });

  it("refuses an unknown event name", async () => {
    const res = await create({ url: "https://hooks.example.org/in", events: ["post.exploded"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/events can only include/);
  });

  it("refuses a channel that belongs to another account", async () => {
    const res = await create({ url: "https://hooks.example.org/in", socialAccountIds: ["other-sa"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/connected to this account/);
  });

  it("stops at 5 endpoints", async () => {
    tables.webhook_endpoints = Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, account_id: "acc1", url: "https://a.example.org", secret: "s", events: [], social_account_ids: null, enabled: true, created_at: new Date().toISOString() }));
    const res = await create({ url: "https://hooks.example.org/in" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/up to 5/);
  });

  it("another account's endpoints do not count toward the limit", async () => {
    tables.webhook_endpoints = Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, account_id: "acc2", url: "https://a.example.org", secret: "s", events: [], social_account_ids: null, enabled: true, created_at: new Date().toISOString() }));
    expect((await create({ url: "https://hooks.example.org/in" })).status).toBe(201);
  });

  it("owner and dashboard session only", async () => {
    auth.role = "member";
    expect((await create({ url: "https://hooks.example.org/in" })).status).toBe(403);
    auth.role = "owner";
    auth.method = "apiKey";
    expect((await create({ url: "https://hooks.example.org/in" })).status).toBe(403);
    expect((await request(app()).get("/webhooks")).status).toBe(403);
    expect(tables.webhook_endpoints ?? []).toHaveLength(0);
  });
});

async function seedOwn(over: Record<string, unknown> = {}) {
  tables.webhook_endpoints ??= [];
  const row = { id: `e${tables.webhook_endpoints.length + 1}`, account_id: "acc1", label: null, url: "https://hooks.example.org/in", secret: "old-secret", events: [], social_account_ids: null, enabled: true, created_at: new Date().toISOString(), ...over };
  tables.webhook_endpoints.push(row);
  return row;
}

describe("PATCH / DELETE / regenerate", () => {
  it("updates events, channels and on/off", async () => {
    const e = await seedOwn();
    const res = await request(app()).patch(`/webhooks/${e.id}`).send({ events: ["post.verified"], socialAccountIds: ["sa2"], enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ events: ["post.verified"], socialAccountIds: ["sa2"], enabled: false });
    expect(tables.webhook_endpoints[0].secret).toBe("old-secret"); // untouched
  });

  it("clearing the channel list means all channels again", async () => {
    const e = await seedOwn({ social_account_ids: ["sa1"] });
    const res = await request(app()).patch(`/webhooks/${e.id}`).send({ socialAccountIds: null });
    expect(res.body.socialAccountIds).toBeNull();
  });

  it("re-checks a changed address", async () => {
    const e = await seedOwn();
    urlIsSafe = false;
    const res = await request(app()).patch(`/webhooks/${e.id}`).send({ url: "https://internal.example.org" });
    expect(res.status).toBe(400);
    expect(tables.webhook_endpoints[0].url).toBe("https://hooks.example.org/in");
  });

  it("cannot touch another account's endpoint", async () => {
    const other = await seedOwn({ account_id: "acc2" });
    expect((await request(app()).patch(`/webhooks/${other.id}`).send({ enabled: false })).status).toBe(404);
    expect((await request(app()).delete(`/webhooks/${other.id}`)).status).toBe(404);
    expect((await request(app()).post(`/webhooks/${other.id}/regenerate-secret`)).status).toBe(404);
    expect((await request(app()).post(`/webhooks/${other.id}/test`)).status).toBe(404);
    expect((await request(app()).get(`/webhooks/${other.id}/deliveries`)).status).toBe(404);
    expect(tables.webhook_endpoints[0]).toMatchObject({ enabled: true, secret: "old-secret" });
  });

  it("deletes an endpoint", async () => {
    const e = await seedOwn();
    expect((await request(app()).delete(`/webhooks/${e.id}`)).body).toEqual({ deleted: true });
    expect(tables.webhook_endpoints).toHaveLength(0);
  });

  it("regenerating gives a new secret, returned once and stored", async () => {
    const e = await seedOwn();
    const res = await request(app()).post(`/webhooks/${e.id}/regenerate-secret`);
    expect(res.status).toBe(200);
    expect(res.body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(tables.webhook_endpoints[0].secret).toBe(res.body.secret);
    expect(res.body.secret).not.toBe("old-secret");
  });
});

describe("POST /webhooks/:id/test", () => {
  it("sends a signed test event and reports success", async () => {
    const e = await seedOwn();
    fetchMock.mockResolvedValueOnce({ status: 200, ok: true } as Response);
    const res = await request(app()).post(`/webhooks/${e.id}/test`);
    expect(res.body).toEqual({ delivered: true, statusCode: 200, error: null });
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];
    expect(JSON.parse(init.body)).toMatchObject({ event: "webhook.test" });
    expect(init.headers["X-LazyRelay-Event"]).toBe("webhook.test");
    expect(init.headers["X-LazyRelay-Signature"]).toBe(signWebhookBody("old-secret", init.body));
  });

  it("reports a failure and does not queue retries for a test", async () => {
    const e = await seedOwn();
    fetchMock.mockResolvedValueOnce({ status: 500, ok: false } as Response);
    const res = await request(app()).post(`/webhooks/${e.id}/test`);
    expect(res.body).toMatchObject({ delivered: false, statusCode: 500 });
    expect(tables.webhook_deliveries[0].status).toBe("failed"); // not left pending for the retry worker
  });
});

describe("GET /webhooks/:id/deliveries", () => {
  it("lists this endpoint's recent deliveries, newest first, without payloads or secrets", async () => {
    const e = await seedOwn();
    tables.webhook_deliveries = [
      { id: "d1", endpoint_id: e.id, event: "post.failed", status: "delivered", attempts: 1, last_status_code: 200, last_error: null, created_at: "2026-10-01T08:00:00Z", delivered_at: "2026-10-01T08:00:01Z", payload: { secret: "nope" } },
      { id: "d2", endpoint_id: e.id, event: "post.verified", status: "failed", attempts: 6, last_status_code: 500, last_error: "Gave up after 6 attempts.", created_at: "2026-10-01T09:00:00Z", delivered_at: null, payload: {} },
      { id: "d3", endpoint_id: "someone-elses", event: "post.verified", status: "delivered", attempts: 1, last_status_code: 200, last_error: null, created_at: "2026-10-01T10:00:00Z", delivered_at: null, payload: {} },
    ];
    const res = await request(app()).get(`/webhooks/${e.id}/deliveries`);
    expect(res.status).toBe(200);
    expect(res.body.deliveries.map((d: { id: string }) => d.id)).toEqual(["d2", "d1"]);
    expect(res.body.deliveries[0]).toMatchObject({ status: "failed", attempts: 6, statusCode: 500, error: "Gave up after 6 attempts." });
    expect(JSON.stringify(res.body)).not.toContain("nope");
  });
});
