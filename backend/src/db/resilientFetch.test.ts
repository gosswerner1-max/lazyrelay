// Behaviour tests for the Supabase client resilience layer. A fake base fetch
// stands in for the network, so nothing here can reach a real service.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createResilientFetch } from "./resilientFetch.js";
import { isTransientDbError, isTransientStatus, readOrUnavailable, throwIfTransient, UpstreamUnavailableError } from "./upstream.js";

const REST = "https://example.supabase.co/rest/v1/accounts?select=id";
const respond = (status: number, body = "{}") => new Response(body, { status });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("retry on gateway errors", () => {
  it("retries a GET after a 522 and returns the good answer", async () => {
    const baseFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(respond(522, "<html>timed out</html>")).mockResolvedValueOnce(respond(200, '{"ok":true}'));
    const sleeps: number[] = [];
    const f = createResilientFetch({ baseFetch, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 });
    const res = await f(REST);
    expect(res.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([Math.floor(0.5 * 250)]); // full jitter: random * base on the first retry
  });

  it("backoff grows with the attempt number and stays under the cap", async () => {
    const baseFetch = vi.fn<typeof fetch>().mockImplementation(async () => respond(522));
    const sleeps: number[] = [];
    const f = createResilientFetch({ baseFetch, attempts: 5, baseDelayMs: 250, capDelayMs: 600, sleep: async (ms) => void sleeps.push(ms), random: () => 0.999 });
    const res = await f(REST);
    expect(res.status).toBe(522); // out of attempts: the caller still sees the real status
    expect(baseFetch).toHaveBeenCalledTimes(5);
    expect(sleeps).toEqual([249, 499, 599, 599]); // 250, 500, then capped at 600, each times 0.999
  });

  it.each([502, 503, 504, 520, 522, 524, 530])("treats %i as retryable for a GET", async (status) => {
    const baseFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(respond(status)).mockResolvedValueOnce(respond(200));
    const f = createResilientFetch({ baseFetch, sleep: async () => {} });
    expect((await f(REST)).status).toBe(200);
  });

  it.each([400, 401, 403, 404, 409, 500])("does not retry a real answer with status %i", async (status) => {
    const baseFetch = vi.fn<typeof fetch>().mockResolvedValue(respond(status));
    const f = createResilientFetch({ baseFetch, sleep: async () => {} });
    expect((await f(REST)).status).toBe(status);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("retries a network error on a GET", async () => {
    const baseFetch = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(respond(200));
    const f = createResilientFetch({ baseFetch, sleep: async () => {} });
    expect((await f(REST)).status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it.each(["POST", "PATCH", "DELETE", "PUT"])("never retries a %s (a lost response does not say whether the write happened)", async (method) => {
    const baseFetch = vi.fn<typeof fetch>().mockResolvedValue(respond(522));
    const f = createResilientFetch({ baseFetch, sleep: async () => {} });
    expect((await f(REST, { method, body: "{}" })).status).toBe(522);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("never retries an RPC (a POST), even on a 522", async () => {
    const baseFetch = vi.fn<typeof fetch>().mockResolvedValue(respond(522));
    const f = createResilientFetch({ baseFetch, sleep: async () => {} });
    await f("https://example.supabase.co/rest/v1/rpc/read_social_token", { method: "POST", body: "{}" });
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("never retries a request the caller cancelled", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const baseFetch = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("aborted", "AbortError"));
    const f = createResilientFetch({ baseFetch, sleep: async () => {} });
    await expect(f(REST, { signal: ctl.signal })).rejects.toThrow();
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });
});

describe("timeout", () => {
  it("abandons a hung request at the ceiling instead of waiting for it", async () => {
    const baseFetch = vi.fn<typeof fetch>().mockImplementation(
      (_i, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")))),
    );
    const f = createResilientFetch({ baseFetch, timeoutMs: 30, attempts: 2, sleep: async () => {} });
    const started = Date.now();
    await expect(f(REST)).rejects.toThrow(/timeout|abort/i);
    expect(baseFetch).toHaveBeenCalledTimes(2); // a hung GET is retried once, then given up on
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("uses the long ceiling for storage and never retries it", async () => {
    let seenSignal: AbortSignal | undefined;
    const baseFetch = vi.fn<typeof fetch>().mockImplementation(async (_i, init) => {
      seenSignal = init?.signal ?? undefined;
      return respond(522);
    });
    const f = createResilientFetch({ baseFetch, timeoutMs: 10, storageTimeoutMs: 60_000, sleep: async () => {} });
    const res = await f("https://example.supabase.co/storage/v1/object/post-media/x.mp4", { method: "GET" });
    expect(res.status).toBe(522);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(seenSignal?.aborted).toBe(false);
  });
});

describe("bounded concurrency", () => {
  it("never has more than maxInFlight requests on the wire at once", async () => {
    let active = 0;
    let peak = 0;
    const baseFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      return respond(200);
    });
    const f = createResilientFetch({ baseFetch, maxInFlight: 3, sleep: async () => {} });
    const results = await Promise.all(Array.from({ length: 12 }, () => f(REST)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(peak).toBeLessThanOrEqual(3);
    expect(baseFetch).toHaveBeenCalledTimes(12);
  });

  it("fails a request that waits too long for a slot, as a timeout", async () => {
    const baseFetch = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {})); // never answers
    const f = createResilientFetch({ baseFetch, maxInFlight: 1, queueTimeoutMs: 20, timeoutMs: 5_000, attempts: 1, sleep: async () => {} });
    void f(REST).catch(() => {}); // occupies the only slot
    await expect(f(REST)).rejects.toThrow(/waiting for a free connection slot/);
  });

  it("releases the slot when a request fails, so the queue keeps moving", async () => {
    const baseFetch = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue(respond(200));
    const f = createResilientFetch({ baseFetch, maxInFlight: 1, attempts: 1, sleep: async () => {} });
    await expect(f(REST)).rejects.toThrow();
    expect((await f(REST)).status).toBe(200);
  });
});

describe("outage vocabulary", () => {
  it("classifies gateway statuses as transient and real answers as not", () => {
    for (const s of [0, 408, 502, 503, 504, 520, 522, 530]) expect(isTransientStatus(s)).toBe(true);
    for (const s of [200, 400, 401, 403, 404, 409, 429, 500, 531, undefined]) expect(isTransientStatus(s)).toBe(false);
  });

  it("recognises a network failure or a Cloudflare error page even with no status", () => {
    expect(isTransientDbError({ error: { message: "TypeError: fetch failed" } })).toBe(true);
    expect(isTransientDbError({ error: { message: "<!DOCTYPE html><title>522: Connection timed out</title>" } })).toBe(true);
    expect(isTransientDbError({ error: { message: "duplicate key value violates unique constraint" }, status: 409 })).toBe(false);
    expect(isTransientDbError({ error: null, status: 522 })).toBe(false);
  });

  it("readOrUnavailable returns null for no rows and throws for any error", () => {
    expect(readOrUnavailable({ data: null, error: null }, "t")).toBeNull();
    expect(readOrUnavailable({ data: { a: 1 }, error: null }, "t")).toEqual({ a: 1 });
    expect(() => readOrUnavailable({ data: null, error: { message: "boom" }, status: 522 }, "resolveTier")).toThrow(UpstreamUnavailableError);
    try {
      readOrUnavailable({ data: null, error: { message: "boom" }, status: 522 }, "resolveTier");
    } catch (err) {
      expect((err as Error).message).toBe("Database unavailable - Retry pending");
      expect((err as UpstreamUnavailableError).op).toBe("resolveTier");
    }
  });

  it("throwIfTransient leaves a real database error for the caller's own handling", () => {
    expect(() => throwIfTransient({ error: { message: "permission denied", code: "42501" }, status: 403 }, "t")).not.toThrow();
    expect(() => throwIfTransient({ error: { message: "x" }, status: 522 }, "t")).toThrow(UpstreamUnavailableError);
  });
});
