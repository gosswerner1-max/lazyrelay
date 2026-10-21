// GET /r/:code — the public redirect. It must always send the visitor somewhere safe, count only real people, and pass the database nothing personal.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

const db = vi.hoisted(() => ({ calls: [] as Array<[string, Record<string, unknown>]>, result: { data: "https://lazyrelay.com/pricing" as unknown, error: null as unknown } }));
vi.mock("./rateLimit.js", () => ({ redirectRateLimit: (_r: any, _s: any, n: any) => n() }));
const rpcHolder = vi.hoisted(() => ({
  rpc: async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    db.calls.push([name, args]);
    return db.result;
  },
}));
vi.mock("../supabase.js", () => ({ supabase: { rpc: (name: string, args: Record<string, unknown>) => rpcHolder.rpc(name, args) } }));

const { buildTrackedLinkRedirectRouter } = await import("./trackedLinkRedirect.js");
const app = () => {
  const a = express();
  a.set("trust proxy", true);
  a.use(buildTrackedLinkRedirectRouter());
  return a;
};
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const HOME = "https://lazyrelay.com/";

beforeEach(() => {
  db.calls = [];
  db.result = { data: "https://lazyrelay.com/pricing", error: null };
  delete process.env.LINK_CLICK_UNIQUE_SALT;
});
afterEach(() => {
  delete process.env.LINK_CLICK_UNIQUE_SALT;
});

describe("GET /r/:code", () => {
  it("counts the click and redirects to the stored destination", async () => {
    const res = await request(app()).get("/r/abCD1234").set("User-Agent", BROWSER);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://lazyrelay.com/pricing");
    expect(db.calls).toEqual([["record_link_click", { p_code: "abCD1234", p_count: true }]]);
  });
  it("is never cached, so every visit reaches the counter", async () => {
    const res = await request(app()).get("/r/abCD1234").set("User-Agent", BROWSER);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });
  it("redirects but does not count link-preview bots, crawlers and requests without a user agent", async () => {
    for (const ua of ["facebookexternalhit/1.1", "Twitterbot/1.0", "curl/8.0"]) {
      db.calls = [];
      const res = await request(app()).get("/r/abCD1234").set("User-Agent", ua);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("https://lazyrelay.com/pricing");
      expect(db.calls[0][1].p_count).toBe(false);
    }
    db.calls = [];
    const none = await request(app()).get("/r/abCD1234").set("User-Agent", "");
    expect(none.status).toBe(302);
    expect(db.calls[0][1].p_count).toBe(false);
  });
  it("does not count a HEAD request", async () => {
    const res = await request(app()).head("/r/abCD1234").set("User-Agent", BROWSER);
    expect(res.status).toBe(302);
    expect(db.calls[0][1].p_count).toBe(false);
  });
  it("sends malformed codes to the home page and never touches the database", async () => {
    for (const code of ["a", "abcde", "x".repeat(17), "ab cd123", "ab%2Fcd123", "';drop table x;--", "abcdé123"]) {
      const res = await request(app()).get("/r/" + encodeURIComponent(code)).set("User-Agent", BROWSER);
      expect(res.status, code).toBe(302);
      expect(res.headers.location, code).toBe(HOME);
    }
    expect(db.calls).toHaveLength(0);
  });
  it("sends a code with broken percent-encoding to the home page instead of an error", async () => {
    for (const raw of ["/r/%E0%A4%A", "/r/%zz", "/r/%"]) {
      const res = await request(app()).get(raw).set("User-Agent", BROWSER);
      expect(res.status, raw).toBe(302);
      expect(res.headers.location, raw).toBe(HOME);
    }
    expect(db.calls).toHaveLength(0);
  });
  it("sends the visitor home when the database does not answer in time (about 2.5 seconds)", async () => {
    const spy = vi.spyOn(rpcHolder, "rpc").mockReturnValue(new Promise(() => {}) as never);
    try {
      const started = Date.now();
      const res = await request(app()).get("/r/abCD1234").set("User-Agent", BROWSER);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(HOME);
      expect(Date.now() - started).toBeGreaterThanOrEqual(2400);
      expect(Date.now() - started).toBeLessThan(6000);
    } finally {
      spy.mockRestore();
    }
  }, 10000);
  it("sends an unknown code to the home page", async () => {
    db.result = { data: null, error: null };
    const res = await request(app()).get("/r/zzzz9999").set("User-Agent", BROWSER);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(HOME);
  });
  it("sends the visitor home (never an error page) when the database fails", async () => {
    db.result = { data: null, error: { message: "boom" } };
    const res = await request(app()).get("/r/abCD1234").set("User-Agent", BROWSER);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(HOME);
  });
  it("refuses to redirect anywhere off the allow-list even if the database returned it (defence in depth)", async () => {
    for (const evil of ["https://evil.com/", "http://lazyrelay.com/", "javascript:alert(1)", "https://lazyrelay.com.evil.com/"]) {
      db.result = { data: evil, error: null };
      const res = await request(app()).get("/r/abCD1234").set("User-Agent", BROWSER);
      expect(res.status, evil).toBe(302);
      expect(res.headers.location, evil).toBe(HOME);
    }
  });
  it("passes only the code and the count flag: no address, no user agent, no visitor identifier, even if a salt is set in the environment", async () => {
    process.env.LINK_CLICK_UNIQUE_SALT = "test-salt";
    await request(app()).get("/r/abCD1234").set("User-Agent", BROWSER).set("X-Forwarded-For", "203.0.113.9");
    expect(Object.keys(db.calls[0][1]).sort()).toEqual(["p_code", "p_count"]);
    expect(JSON.stringify(db.calls[0][1])).not.toContain("203.0.113.9");
    expect(JSON.stringify(db.calls[0][1])).not.toContain("Mozilla");
  });
});
