import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LazyRelay, LazyRelayError, describeApiError } from "../src/index.js";
import { FakeApi, KEY } from "./fakeApi.js";

const api = new FakeApi();
let client: LazyRelay;

beforeAll(async () => {
  await api.start();
  client = new LazyRelay({ apiKey: KEY, baseUrl: api.baseUrl });
});
afterAll(() => api.stop());
beforeEach(() => api.reset());

async function failure(promise: Promise<unknown>): Promise<LazyRelayError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(LazyRelayError);
    return err as LazyRelayError;
  }
  throw new Error("expected the call to fail");
}

describe("error mapping through a real HTTP response", () => {
  const table: Array<{ status: number; error: string; kind: string; retryable: boolean; hint: RegExp | null }> = [
    { status: 400, error: "scheduledFor can't be in the past", kind: "validation", retryable: false, hint: /ISO 8601/ },
    { status: 400, error: "tiktokPrivacyLevel is required when posting to TikTok", kind: "validation", retryable: false, hint: /tiktok\.creatorInfo/ },
    { status: 400, error: "options.tiktok is not used by this platform", kind: "validation", retryable: false, hint: /rules\.get/ },
    { status: 401, error: "Invalid API key", kind: "auth", retryable: false, hint: null },
    { status: 403, error: "Free tier limit reached: 10 posts per connected account per month. Upgrade to Starter for unlimited posts.", kind: "plan_limit", retryable: false, hint: /plan limit/ },
    { status: 403, error: "Social account not found or not owned by this caller", kind: "permission", retryable: false, hint: /accounts\.list/ },
    { status: 403, error: "This endpoint requires signing in with your account, not an API key", kind: "permission", retryable: false, hint: null },
    { status: 404, error: "Not found or not owned by this caller", kind: "not_found", retryable: false, hint: /accounts\.list/ },
    { status: 409, error: "Only a pending post can be rescheduled.", kind: "conflict", retryable: false, hint: null },
    { status: 422, error: "Pinterest allows 10 posts in 24 hours (rolling window)", kind: "validation", retryable: false, hint: /slots\.next/ },
    { status: 500, error: "Something went wrong on our end. Please try again.", kind: "server", retryable: true, hint: null },
  ];

  it.each(table)("POST $status maps to $kind", async (row) => {
    api.replyWith({ status: row.status, body: { error: row.error } });
    const err = await failure(client.posts.schedule({ socialAccountId: "a1", content: "x", scheduledFor: "2030-01-01T00:00:00Z" }));
    expect(err.status).toBe(row.status);
    expect(err.kind).toBe(row.kind);
    expect(err.message).toBe(row.error);
    expect(err.retryable).toBe(row.retryable);
    if (row.hint) expect(err.hint).toMatch(row.hint);
    else expect(err.hint).toBeNull();
    expect(api.requests).toHaveLength(1); // a POST is never retried, even on a 5xx
  });

  it("maps a 429 to rate_limited and retryable (POST, so no retry)", async () => {
    api.replyWith({ status: 429, body: { error: "Too many requests. Please slow down." } });
    const err = await failure(client.posts.approve("p1"));
    expect(err).toMatchObject({ status: 429, kind: "rate_limited", retryable: true });
    expect(api.requests).toHaveLength(1);
  });

  it("keeps the whole error body for errors that carry extra fields", async () => {
    const body = { error: "Pinterest allows 5 posts per rolling 24 hours", code: "platform_daily_limit", nextAvailable: "2026-10-02T09:00:00.000Z" };
    api.replyWith({ status: 422, body });
    const err = await failure(client.posts.schedule({ socialAccountId: "a1", content: "x", scheduledFor: "2030-01-01T00:00:00Z" }));
    expect(err.body).toEqual(body);
  });

  it("falls back to a generic message when the body has no error field", async () => {
    api.replyWith({ status: 502, text: "<html>Bad gateway</html>" });
    const err = await failure(client.posts.approve("p1"));
    expect(err.message).toBe("LazyRelay API error (HTTP 502)");
    expect(err.kind).toBe("server");
  });

  it("maps an unmapped status to unknown", async () => {
    api.replyWith({ status: 418, body: { error: "Storage quota reached" } });
    const err = await failure(client.posts.approve("p1"));
    expect(err.kind).toBe("unknown");
    expect(err.retryable).toBe(false);
  });

  it("reports a non JSON success body clearly", async () => {
    api.replyWith({ status: 200, text: "<html>hello</html>" });
    const err = await failure(client.accounts.list().catch((e) => Promise.reject(e)));
    expect(err.message).toMatch(/not JSON/);
    expect(err.status).toBe(0);
  });

  it("never puts the API key in an error", async () => {
    api.replyWith({ status: 401, body: { error: "Invalid API key" } });
    const err = await failure(client.accounts.list());
    const everything = [err.message, err.hint ?? "", err.stack ?? "", JSON.stringify(err), JSON.stringify(err.body ?? null), err.name].join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("lzr_live_");
  });

  it("never puts the API key in a network error either", async () => {
    const dead = new LazyRelay({ apiKey: KEY, baseUrl: "http://127.0.0.1:1/api", timeoutMs: 2000 });
    const err = await failure(dead.posts.approve("p1"));
    expect(err.status).toBe(0);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/Could not reach LazyRelay/);
    expect(JSON.stringify(err) + err.message + err.stack).not.toContain(KEY);
  });
});

describe("retries", () => {
  it("retries an idempotent GET once on 503 and then succeeds", async () => {
    api.reset((_req, count) => (count === 1 ? { status: 503, body: { error: "Unavailable" }, headers: { "Retry-After": "0" } } : { status: 200, body: [{ id: "a1" }] }));
    const result = await client.accounts.list();
    expect(result).toEqual([{ id: "a1" }]);
    expect(api.requests).toHaveLength(2);
    expect(api.requests[0].method).toBe("GET");
    expect(api.requests[1].method).toBe("GET");
    expect(api.requests[1].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("retries a GET once on 429 and honours Retry-After", async () => {
    api.reset((_req, count) => (count === 1 ? { status: 429, body: { error: "Too many requests" }, headers: { "Retry-After": "1" } } : { status: 200, body: { posts: [] } }));
    const start = Date.now();
    await client.mentions.list();
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
    expect(api.requests).toHaveLength(2);
  });

  it("gives up after one retry and throws the second failure", async () => {
    api.reset((_req, count) => ({ status: 500, body: { error: `boom ${count}` }, headers: { "Retry-After": "0" } }));
    const err = await failure(client.accounts.list());
    expect(api.requests).toHaveLength(2);
    expect(err.message).toBe("boom 2");
    expect(err.kind).toBe("server");
  });

  it("does not retry a GET on a 4xx", async () => {
    api.replyWith({ status: 404, body: { error: "Not found" } });
    await failure(client.slots.next("a1"));
    expect(api.requests).toHaveLength(1);
  });

  it("does not retry a POST on 503", async () => {
    api.replyWith({ status: 503, body: { error: "Unavailable" }, headers: { "Retry-After": "0" } });
    const err = await failure(client.posts.schedule({ socialAccountId: "a1", content: "x", scheduledFor: "2030-01-01T00:00:00Z" }));
    expect(api.requests).toHaveLength(1);
    expect(err.kind).toBe("server");
    expect(err.retryable).toBe(true);
  });

  it.each([
    ["PATCH", () => client.posts.approve("p1")],
    ["DELETE", () => client.posts.delete("p1")],
    ["POST", () => client.posts.publishNow({ socialAccountId: "a1", content: "x" })],
  ] as const)("does not retry a %s on 500 or 429", async (_method, call) => {
    for (const status of [500, 429]) {
      api.reset(() => ({ status, body: { error: "nope" }, headers: { "Retry-After": "0" } }));
      await failure(call());
      expect(api.requests).toHaveLength(1);
    }
  });

  it("retries a GET once after a network failure", async () => {
    let calls = 0;
    const flaky = new LazyRelay({
      apiKey: KEY,
      baseUrl: "https://example.test/api",
      fetch: async () => {
        calls++;
        if (calls === 1) throw new TypeError("fetch failed");
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    expect(await flaky.accounts.list()).toEqual([]);
    expect(calls).toBe(2);
  });

  it("does not retry a POST after a network failure", async () => {
    let calls = 0;
    const flaky = new LazyRelay({
      apiKey: KEY,
      baseUrl: "https://example.test/api",
      fetch: async () => {
        calls++;
        throw new TypeError("fetch failed");
      },
    });
    await failure(flaky.posts.approve("p1"));
    expect(calls).toBe(1);
  });
});

describe("413 storage quota", () => {
  it("maps to plan_limit and passes the message through", async () => {
    api.replyWith({ status: 413, body: { error: "Storage quota reached. Delete files or upgrade." } });
    const err = await failure(client.posts.approve("p1"));
    expect(err).toMatchObject({ status: 413, kind: "plan_limit", retryable: false, message: "Storage quota reached. Delete files or upgrade." });
    expect(describeApiError(413, "x").kind).toBe("plan_limit");
  });
});

describe("describeApiError (port of the backend rules)", () => {
  it("classifies by status", () => {
    expect(describeApiError(400, "x").kind).toBe("validation");
    expect(describeApiError(422, "x").kind).toBe("validation");
    expect(describeApiError(401, "x").kind).toBe("auth");
    expect(describeApiError(403, "This API key isn't permitted to generate proof-sharing links.").kind).toBe("permission");
    expect(describeApiError(403, "Your plan allows 3 active review links").kind).toBe("plan_limit");
    expect(describeApiError(403, "RSS feeds are a paid-plan feature.").kind).toBe("plan_limit");
    expect(describeApiError(404, "x").kind).toBe("not_found");
    expect(describeApiError(409, "x").kind).toBe("conflict");
    expect(describeApiError(429, "x").kind).toBe("rate_limited");
    expect(describeApiError(503, "x").kind).toBe("server");
    expect(describeApiError(418, "x").kind).toBe("unknown");
  });

  it("only rate_limited and server are retryable", () => {
    expect(describeApiError(429, "x").retryable).toBe(true);
    expect(describeApiError(500, "x").retryable).toBe(true);
    for (const s of [400, 401, 403, 404, 409, 422]) expect(describeApiError(s, "x").retryable).toBe(false);
  });

  it("picks the first matching hint, in the backend order", () => {
    expect(describeApiError(400, "Pinterest board is required").hint).toMatch(/pinterest\.boards/);
    expect(describeApiError(400, "This account needs to reconnect").hint).toMatch(/reconnected/);
    expect(describeApiError(400, "nothing special").hint).toBeNull();
  });
});
