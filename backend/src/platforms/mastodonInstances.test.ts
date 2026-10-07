// Mastodon on a customer's own instance (master list #11), and proof that accounts connected the
// old way (bare token, mastodon.social) behave exactly as before. fetch, the SSRF guard and the
// app-registration cache are stubbed; nothing real is called and no real credentials appear.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../supabase.js", () => ({ supabase: {} }));
vi.mock("../urlSafety.js", () => ({
  isSafeMediaUrl: vi.fn(async (url: string) =>
    new URL(url).hostname.startsWith("internal")
      ? { safe: false, reason: "must not point at a private, internal, or reserved address" }
      : new URL(url).hostname.startsWith("nxdomain")
        ? { safe: false, reason: "could not resolve" }
        : { safe: true, addresses: ["93.184.216.34"] },
  ),
}));
const apps = vi.hoisted(() => ({
  stored: new Map<string, { clientId: string; clientSecret: string }>(),
  saves: 0,
  deleted: [] as string[],
}));
vi.mock("./mastodonApps.js", () => ({
  deleteMastodonApp: vi.fn(async (instance: string) => {
    apps.deleted.push(instance);
    apps.stored.delete(instance);
  }),
  loadMastodonApp: vi.fn(async (instance: string) => apps.stored.get(instance) ?? null),
  saveMastodonApp: vi.fn(async (instance: string, _r: string, app: { clientId: string; clientSecret: string }) => {
    apps.saves += 1;
    apps.stored.set(instance, app);
    return app;
  }),
}));
vi.mock("./streamUpload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./streamUpload.js")>();
  return { ...actual, fetchMediaForStreaming: vi.fn() };
});

import { isSafeMediaUrl } from "../urlSafety.js";
import { fetchMediaForStreaming } from "./streamUpload.js";
import { MastodonAdapter, parseMastodonCredentials, normalizeMastodonInstance } from "./mastodon.js";

const TOKEN = "tok-secret-value-123";
const CLIENT_SECRET = "client-secret-value-456";
const ORIGIN = "https://hachyderm.io";
const newCreds = (over: Record<string, unknown> = {}) => JSON.stringify({ instance: ORIGIN, token: TOKEN, ...over });

type Call = { url: string; init: Record<string, any> | undefined };
let calls: Call[];
let handler: (url: string, init: Record<string, any> | undefined) => Response | { ok: boolean; status: number; json: () => Promise<unknown> } | Promise<never>;

const real = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
// What the existing tests return for the default instance: only status/ok/json exist.
const fake = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

const adapter = () => new MastodonAdapter("https://api.example.org/cb");
const postReq = (accessToken: string, over: Record<string, unknown> = {}) =>
  ({ socialAccountId: "sa1", content: "Hello", mediaUrl: null, coverImageUrl: null, accessToken, ...over }) as never;

beforeEach(() => {
  calls = [];
  apps.stored.clear();
  apps.saves = 0;
  apps.deleted = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: Record<string, any>) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const noSecrets = (text: string | null | undefined) => {
  expect(text ?? "").not.toContain(TOKEN);
  expect(text ?? "").not.toContain(CLIENT_SECRET);
};

describe("normalizeMastodonInstance", () => {
  it("accepts a bare host, an https origin and a full handle", () => {
    expect(normalizeMastodonInstance("Hachyderm.IO")).toEqual({ ok: true, origin: ORIGIN, host: "hachyderm.io" });
    expect(normalizeMastodonInstance("https://hachyderm.io/")).toMatchObject({ ok: true, origin: ORIGIN });
    expect(normalizeMastodonInstance("@me@hachyderm.io")).toMatchObject({ ok: true, origin: ORIGIN });
    expect(normalizeMastodonInstance("  mastodon.social ")).toMatchObject({ ok: true, origin: "https://mastodon.social" });
  });

  it("refuses anything that is not a bare https host name", () => {
    for (const bad of [
      "",
      "http://hachyderm.io",
      "https://user:pw@hachyderm.io",
      "hachyderm.io:8443",
      "https://hachyderm.io/web",
      "hachyderm.io?x=1",
      "https://hachyderm.io/#top",
      "10.0.0.5",
      "[::1]",
      "localhost",
      "not a host",
      "ftp://hachyderm.io",
    ]) {
      const r = normalizeMastodonInstance(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error).not.toMatch(/[–—]/);
    }
  });
});

describe("parseMastodonCredentials", () => {
  it("a bare string is the old format: mastodon.social", () => {
    expect(parseMastodonCredentials(TOKEN)).toEqual({ origin: "https://mastodon.social", token: TOKEN, isDefault: true });
  });

  it("the JSON format names the instance", () => {
    expect(parseMastodonCredentials(newCreds())).toEqual({ origin: ORIGIN, token: TOKEN, isDefault: false });
  });

  it("the JSON naming mastodon.social is still the default, unguarded path", () => {
    expect(parseMastodonCredentials(newCreds({ instance: "https://mastodon.social" })).isDefault).toBe(true);
  });

  it("damaged JSON is refused with a plain message that holds no secret", () => {
    for (const bad of ["{not json", JSON.stringify({ instance: ORIGIN }), JSON.stringify({ token: TOKEN }), newCreds({ instance: "http://hachyderm.io" }), newCreds({ token: "" })]) {
      let message = "";
      try {
        parseMastodonCredentials(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/damaged/);
      noSecrets(message);
    }
  });
});

// ---------------------------------------------------------------------------------------
// Old-format accounts: behave exactly as before
// ---------------------------------------------------------------------------------------

describe("old-format accounts (bare token) are unchanged", () => {
  const expectPlain = (c: Call, url: string) => {
    expect(c.url).toBe(url);
    expect(c.init?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    // No guard, no pinned connection, no redirect setting, no timeout signal: the very same call as before.
    expect(c.init).not.toHaveProperty("redirect");
    expect(c.init).not.toHaveProperty("dispatcher");
    expect(c.init).not.toHaveProperty("signal");
  };

  it("post goes to mastodon.social with the bare token and never touches the address guard", async () => {
    handler = () => fake(200, { id: "s1" });
    const r = await adapter().post(postReq(TOKEN));
    expect(r).toEqual({ success: true, platformPostId: "s1", errorMessage: null });
    expect(calls).toHaveLength(1);
    expectPlain(calls[0], "https://mastodon.social/api/v1/statuses");
    expect(JSON.parse(calls[0].init!.body)).toEqual({ status: "Hello", visibility: "public" });
    expect(isSafeMediaUrl).not.toHaveBeenCalled();
  });

  it("post failure message is the server's own text, untouched", async () => {
    handler = () => fake(422, { error: "x".repeat(500) });
    const r = await adapter().post(postReq(TOKEN));
    expect(r.errorMessage).toBe("x".repeat(500));
  });

  it("verifyPublished, getComments, replyToComment, postChainReply, getPostMetrics and getFollowerCount", async () => {
    handler = (url) => {
      if (url.endsWith("/context")) return fake(200, { descendants: [{ id: "r1", content: "<p>hi</p>", account: { username: "bob" } }] });
      if (url.endsWith("/verify_credentials")) return fake(200, { followers_count: 42 });
      if (url.endsWith("/api/v1/statuses")) return fake(200, { id: "new1" });
      return fake(200, { id: "s1", url: "https://mastodon.social/@a/s1", favourites_count: 3, reblogs_count: 2, replies_count: 1 });
    };
    const a = adapter();

    expect(await a.verifyPublished("s1", TOKEN)).toEqual({ verifiedLive: true, platformPostUrl: "https://mastodon.social/@a/s1", errorMessage: null });
    expectPlain(calls[0], "https://mastodon.social/api/v1/statuses/s1");

    const comments = await a.getComments("s1", TOKEN);
    expect(comments.comments).toEqual([{ id: "r1", author: "bob", text: "hi", url: null, createdAt: null }]);
    expectPlain(calls[1], "https://mastodon.social/api/v1/statuses/s1/context");

    expect(await a.replyToComment("r1", "thanks", TOKEN)).toMatchObject({ success: true, errorMessage: null, platformReplyId: expect.any(String) });
    expectPlain(calls[2], "https://mastodon.social/api/v1/statuses");
    expect(JSON.parse(calls[2].init!.body)).toEqual({ status: "thanks", in_reply_to_id: "r1", visibility: "public" });

    expect(await a.postChainReply({ rootPostId: "s1", parentPostId: "s1", text: "more", accessToken: TOKEN })).toEqual({ success: true, platformPostId: "new1", errorMessage: null });
    expectPlain(calls[3], "https://mastodon.social/api/v1/statuses");

    expect(await a.getPostMetrics("s1", TOKEN)).toEqual({ likes: 3, comments: 1, shares: 2, views: null, errorMessage: null });
    expectPlain(calls[4], "https://mastodon.social/api/v1/statuses/s1");

    expect(await a.getFollowerCount(TOKEN)).toBe(42);
    expectPlain(calls[5], "https://mastodon.social/api/v1/accounts/verify_credentials");
    expect(isSafeMediaUrl).not.toHaveBeenCalled();
  });

  it("verifyPublished falls back to the mastodon.social status page when the status has no url", async () => {
    handler = () => fake(200, { id: "s1" });
    expect((await adapter().verifyPublished("s1", TOKEN)).platformPostUrl).toBe("https://mastodon.social/web/statuses/s1");
  });

  it("media upload and polling use mastodon.social with no guard", async () => {
    vi.useFakeTimers();
    try {
      (fetchMediaForStreaming as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
        sizeBytes: 3,
        contentType: "image/png",
      }));
      let polls = 0;
      handler = (url) => {
        if (url.endsWith("/api/v2/media")) return fake(202, { id: "m1" });
        if (url.endsWith("/api/v1/media/m1")) return polls++ === 0 ? fake(206, {}) : fake(200, {});
        return fake(200, { id: "s1" });
      };
      const p = adapter().post(postReq(TOKEN, { mediaUrl: "https://cdn.example.com/a.png" }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await p).toMatchObject({ success: true, platformPostId: "s1" });
      expect(calls.map((c) => c.url)).toEqual([
        "https://mastodon.social/api/v2/media",
        "https://mastodon.social/api/v1/media/m1",
        "https://mastodon.social/api/v1/media/m1",
        "https://mastodon.social/api/v1/statuses",
      ]);
      for (const c of calls) expect(c.init).not.toHaveProperty("dispatcher");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a network failure still propagates as the same thrown error", async () => {
    handler = () => Promise.reject(new Error("socket hang up")) as never;
    await expect(adapter().post(postReq(TOKEN))).rejects.toThrow("socket hang up");
  });

  it("connect without an instance is the old flow: registers on mastodon.social, bare token, numeric account id", async () => {
    handler = (url) => {
      if (url.endsWith("/api/v1/apps")) return fake(200, { client_id: "cid", client_secret: CLIENT_SECRET });
      if (url.endsWith("/oauth/token")) return fake(200, { access_token: TOKEN });
      if (url.endsWith("/verify_credentials")) return fake(200, { id: "109", username: "lazy", display_name: "Lazy Relay" });
      return fake(404, {});
    };
    const a = adapter();
    const url = new URL(await a.getAuthorizeUrl("st1"));
    expect(url.origin + url.pathname).toBe("https://mastodon.social/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("state")).toBe("st1");

    const result = await a.exchangeCode("the-code");
    expect(result).toEqual({ accessToken: TOKEN, refreshToken: null, expiresAt: null, platformAccountId: "109", displayName: "Lazy Relay" });
    // The default instance never uses the database cache or the guard.
    expect(apps.saves).toBe(0);
    expect(isSafeMediaUrl).not.toHaveBeenCalled();
    for (const c of calls) expect(c.init).not.toHaveProperty("dispatcher");
  });

  it("connect with an empty or mastodon.social context is also the old flow", async () => {
    handler = (url) => (url.endsWith("/api/v1/apps") ? fake(200, { client_id: "cid", client_secret: CLIENT_SECRET }) : fake(404, {}));
    const a = adapter();
    expect((await a.getAuthorizeUrl("s", "")).startsWith("https://mastodon.social/oauth/authorize?")).toBe(true);
    expect((await a.getAuthorizeUrl("s", "https://mastodon.social")).startsWith("https://mastodon.social/oauth/authorize?")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// New-format accounts: a customer's own instance
// ---------------------------------------------------------------------------------------

describe("accounts on a customer's own instance", () => {
  const expectGuarded = (c: Call, url: string) => {
    expect(c.url).toBe(url);
    // Only the inner token is ever sent as the credential, never the stored JSON.
    expect(c.init?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(c.init?.redirect).toBe("manual");
    expect(c.init?.dispatcher).toBeDefined();
    expect(c.init?.signal).toBeDefined();
  };

  it("every call goes to that instance through the guard, pinned, with redirects off", async () => {
    handler = (url) => {
      if (url.endsWith("/context")) return real(200, { descendants: [{ id: "r1", content: "<b>yo</b>", account: { display_name: "Bo" } }] });
      if (url.endsWith("/verify_credentials")) return real(200, { followers_count: 7 });
      if (url.endsWith("/api/v1/statuses")) return real(200, { id: "new1" });
      return real(200, { id: "s1", url: `${ORIGIN}/@a/s1`, favourites_count: 1, reblogs_count: 0, replies_count: 2 });
    };
    const a = adapter();
    const c = newCreds();

    expect(await a.post(postReq(c))).toEqual({ success: true, platformPostId: "new1", errorMessage: null });
    expectGuarded(calls[0], `${ORIGIN}/api/v1/statuses`);

    expect(await a.verifyPublished("s1", c)).toEqual({ verifiedLive: true, platformPostUrl: `${ORIGIN}/@a/s1`, errorMessage: null });
    expectGuarded(calls[1], `${ORIGIN}/api/v1/statuses/s1`);

    expect((await a.getComments("s1", c)).comments).toEqual([{ id: "r1", author: "Bo", text: "yo", url: null, createdAt: null }]);
    expectGuarded(calls[2], `${ORIGIN}/api/v1/statuses/s1/context`);

    expect(await a.replyToComment("r1", "thanks", c)).toMatchObject({ success: true, errorMessage: null, platformReplyId: expect.any(String) });
    expectGuarded(calls[3], `${ORIGIN}/api/v1/statuses`);

    expect(await a.postChainReply({ rootPostId: "s1", parentPostId: "s1", text: "more", accessToken: c })).toEqual({ success: true, platformPostId: "new1", errorMessage: null });
    expectGuarded(calls[4], `${ORIGIN}/api/v1/statuses`);

    expect(await a.getPostMetrics("s1", c)).toEqual({ likes: 1, comments: 2, shares: 0, views: null, errorMessage: null });
    expectGuarded(calls[5], `${ORIGIN}/api/v1/statuses/s1`);

    expect(await a.getFollowerCount(c)).toBe(7);
    expectGuarded(calls[6], `${ORIGIN}/api/v1/accounts/verify_credentials`);

    expect(isSafeMediaUrl).toHaveBeenCalledTimes(7);
    for (const call of (isSafeMediaUrl as unknown as ReturnType<typeof vi.fn>).mock.calls) expect(call[0]).toBe(ORIGIN);
  });

  it("verifyPublished falls back to the instance's own status page", async () => {
    handler = () => real(200, { id: "s1" });
    expect((await adapter().verifyPublished("s1", newCreds())).platformPostUrl).toBe(`${ORIGIN}/web/statuses/s1`);
  });

  it("an address the guard refuses is never contacted, on every method", async () => {
    handler = () => real(200, { id: "s1" });
    const c = newCreds({ instance: "https://internal.example" });
    const a = adapter();
    const results = [
      (await a.post(postReq(c))).errorMessage,
      (await a.verifyPublished("s1", c)).errorMessage,
      (await a.getComments("s1", c)).errorMessage,
      (await a.replyToComment("r", "t", c)).errorMessage,
      (await a.postChainReply({ rootPostId: "s", parentPostId: "s", text: "t", accessToken: c })).errorMessage,
      (await a.getPostMetrics("s1", c)).errorMessage,
    ];
    for (const m of results) {
      expect(m).toMatch(/not allowed/);
      noSecrets(m);
    }
    expect(await a.getFollowerCount(c)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("a dropped connection becomes a plain message with no token, URL or error text", async () => {
    handler = () => Promise.reject(new Error(`connect failed for ${ORIGIN} Bearer ${TOKEN}`)) as never;
    const r = await adapter().verifyPublished("s1", newCreds());
    expect(r.errorMessage).toBe("Could not reach hachyderm.io. Check the server address and try again later.");
    noSecrets(r.errorMessage);
    expect(r.errorMessage).not.toContain("https://");
  });

  it("a lost answer to the status creation is reported as unconfirmed, not as a plain failure", async () => {
    handler = () => Promise.reject(new Error(`socket closed ${TOKEN}`)) as never;
    const r = await adapter().post(postReq(newCreds()));
    expect(r.success).toBe(false);
    expect(r.platformPostId).toBeNull();
    expect(r.errorMessage).toMatch(/unconfirmed/);
    expect(r.errorMessage).toMatch(/Check the account on Mastodon before trying again/);
    noSecrets(r.errorMessage);
    expect(r.errorMessage).not.toMatch(/[\u2013\u2014]/);
  });

  it("the status creation on a customer instance carries an Idempotency-Key; the default instance sends none", async () => {
    handler = () => real(200, { id: "s1" });
    await adapter().post(postReq(newCreds()));
    await adapter().post(postReq(newCreds()));
    const k1 = calls[0].init?.headers?.["Idempotency-Key"];
    const k2 = calls[1].init?.headers?.["Idempotency-Key"];
    expect(k1).toMatch(/^[0-9a-f-]{36}$/);
    expect(k2).not.toBe(k1);

    calls = [];
    handler = () => fake(200, { id: "s1" });
    await adapter().post(postReq(TOKEN));
    expect(calls[0].init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });
  });

  it("an address that only failed to resolve says it could not be reached, not that it is blocked", async () => {
    handler = () => real(200, {});
    const r = await adapter().verifyPublished("s1", newCreds({ instance: "https://nxdomain.example" }));
    expect(r.errorMessage).toBe("Could not reach nxdomain.example. Check the address and try again later.");
    expect(r.errorMessage).not.toMatch(/not allowed/);
    expect(calls).toHaveLength(0);
  });

  it("links from a customer instance are only used when https and on the instance's own host", async () => {
    const a = adapter();
    const c = newCreds();
    for (const bad of ["javascript:alert(1)", "https://evil.example/@a/s1", "http://hachyderm.io/@a/s1", "//hachyderm.io/x", "not a url"]) {
      handler = () => real(200, { id: "s1", url: bad });
      expect((await a.verifyPublished("s1", c)).platformPostUrl, bad).toBe(`${ORIGIN}/web/statuses/s1`);
    }
    handler = () => real(200, { id: "s1", url: `${ORIGIN}/@a/s1` });
    expect((await a.verifyPublished("s1", c)).platformPostUrl).toBe(`${ORIGIN}/@a/s1`);

    handler = () =>
      real(200, {
        descendants: [
          { id: "r1", content: "x", url: "javascript:alert(1)" },
          { id: "r2", content: "x", url: "https://evil.example/r2" },
          { id: "r3", content: "x", url: `${ORIGIN}/@b/r3` },
          { id: "r4", content: "x" },
        ],
      });
    const urls = (await a.getComments("s1", c)).comments.map((x) => x.url);
    expect(urls).toEqual([`${ORIGIN}/web/statuses/r1`, `${ORIGIN}/web/statuses/r2`, `${ORIGIN}/@b/r3`, null]);
  });

  it("the default instance keeps the URL the server returns, whatever it is", async () => {
    handler = () => fake(200, { id: "s1", url: "https://somewhere.example/x" });
    expect((await adapter().verifyPublished("s1", TOKEN)).platformPostUrl).toBe("https://somewhere.example/x");
    handler = () => fake(200, { descendants: [{ id: "r1", content: "x", url: "https://somewhere.example/r1" }] });
    expect((await adapter().getComments("s1", TOKEN)).comments[0].url).toBe("https://somewhere.example/r1");
  });

  it("a redirect is not followed and reads as a failure", async () => {
    handler = () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } });
    const r = await adapter().post(postReq(newCreds()));
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Mastodon status creation failed (HTTP 302)" });
    expect(calls).toHaveLength(1);
  });

  it("a huge answer is refused unread, and server error text is cut", async () => {
    handler = () => real(200, { id: "x" }, { "content-length": String(50 * 1024 * 1024) });
    const big = await adapter().post(postReq(newCreds()));
    expect(big.success).toBe(false);

    handler = () => real(422, { error: "e".repeat(2000) });
    const r = await adapter().post(postReq(newCreds()));
    expect(r.errorMessage).toHaveLength(300);
  });

  it("an unreadable (not JSON) answer does not crash", async () => {
    handler = () => new Response("<html>oops</html>", { status: 502 });
    const r = await adapter().post(postReq(newCreds()));
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Mastodon status creation failed (HTTP 502)" });
  });

  it("a damaged stored connection fails plainly on every method", async () => {
    const a = adapter();
    const bad = "{broken";
    expect((await a.post(postReq(bad))).errorMessage).toMatch(/damaged/);
    expect((await a.verifyPublished("s", bad)).errorMessage).toMatch(/damaged/);
    expect((await a.getComments("s", bad)).errorMessage).toMatch(/damaged/);
    expect((await a.replyToComment("r", "t", bad)).errorMessage).toMatch(/damaged/);
    expect((await a.postChainReply({ rootPostId: "s", parentPostId: "s", text: "t", accessToken: bad })).errorMessage).toMatch(/damaged/);
    expect((await a.getPostMetrics("s", bad)).errorMessage).toMatch(/damaged/);
    expect(await a.getFollowerCount(bad)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("media upload goes to the instance, with the guard, and polls until ready", async () => {
    vi.useFakeTimers();
    try {
      (fetchMediaForStreaming as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
        sizeBytes: 3,
        contentType: "video/mp4",
      }));
      let polls = 0;
      handler = (url) => {
        if (url.endsWith("/api/v2/media")) return real(202, { id: "m1" });
        if (url.endsWith("/api/v1/media/m1")) return polls++ === 0 ? real(206, {}) : real(200, {});
        return real(200, { id: "s1" });
      };
      const p = adapter().post(postReq(newCreds(), { mediaUrl: "https://cdn.example.com/a.mp4" }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await p).toMatchObject({ success: true, platformPostId: "s1" });
      expect(calls.map((c) => c.url)).toEqual([
        `${ORIGIN}/api/v2/media`,
        `${ORIGIN}/api/v1/media/m1`,
        `${ORIGIN}/api/v1/media/m1`,
        `${ORIGIN}/api/v1/statuses`,
      ]);
      for (const c of calls) {
        expect(c.init?.redirect).toBe("manual");
        expect(c.init?.dispatcher).toBeDefined();
        expect(c.init?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
      }
      expect(calls[0].init?.duplex).toBe("half");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------------------
// Connect flow for a customer's instance
// ---------------------------------------------------------------------------------------

describe("connecting an account on another instance", () => {
  const hostServer = () => {
    handler = (url, init) => {
      if (url === `${ORIGIN}/api/v1/apps`) return real(200, { client_id: "cid-h", client_secret: CLIENT_SECRET });
      if (url === `${ORIGIN}/oauth/token`) return real(200, { access_token: TOKEN });
      if (url === `${ORIGIN}/api/v1/accounts/verify_credentials`) return real(200, { id: "1", username: "alice", display_name: "Alice A" });
      return real(404, {});
    };
  };

  it("registers the app on that instance once, then points the customer at it", async () => {
    hostServer();
    const a = adapter();
    const url = new URL(await a.getAuthorizeUrl("st1", ORIGIN));
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/oauth/authorize`);
    expect(url.searchParams.get("client_id")).toBe("cid-h");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.org/cb");
    expect(url.searchParams.get("state")).toBe("st1");

    const reg = calls.find((c) => c.url.endsWith("/api/v1/apps"))!;
    expect(reg.init?.redirect).toBe("manual");
    expect(reg.init?.dispatcher).toBeDefined();
    expect(JSON.parse(reg.init!.body)).toMatchObject({ client_name: "LazyRelay", redirect_uris: "https://api.example.org/cb" });

    await a.getAuthorizeUrl("st2", ORIGIN);
    expect(calls.filter((c) => c.url.endsWith("/api/v1/apps"))).toHaveLength(1); // in-process cache
    expect(apps.saves).toBe(1);
  });

  it("uses the app already stored in the database instead of registering again", async () => {
    hostServer();
    apps.stored.set(ORIGIN, { clientId: "from-db", clientSecret: CLIENT_SECRET });
    const url = new URL(await adapter().getAuthorizeUrl("st1", ORIGIN));
    expect(url.searchParams.get("client_id")).toBe("from-db");
    expect(calls).toHaveLength(0);
  });

  it("refuses a bad or blocked instance before anything is sent", async () => {
    hostServer();
    await expect(adapter().getAuthorizeUrl("s", "http://hachyderm.io")).rejects.toThrow(/https/);
    await expect(adapter().getAuthorizeUrl("s", "https://internal.example")).rejects.toThrow(/not allowed/);
    expect(calls).toHaveLength(0);
  });

  it("a server that does not look like Mastodon gives a plain message", async () => {
    handler = () => real(404, { error: "nope", secret: CLIENT_SECRET });
    const err = (await adapter().getAuthorizeUrl("s", ORIGIN).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/did not accept the LazyRelay registration/);
    noSecrets(err.message);
  });

  it("exchanges the code on that instance and stores the JSON credentials with a host-qualified account id", async () => {
    hostServer();
    const a = adapter();
    const result = await a.exchangeCode("the-code", undefined, ORIGIN);
    expect(result).toEqual({
      accessToken: JSON.stringify({ instance: ORIGIN, token: TOKEN }),
      refreshToken: null,
      expiresAt: null,
      platformAccountId: "alice@hachyderm.io",
      displayName: "alice@hachyderm.io",
    });
    // The stored form reads back as a custom-instance account.
    expect(parseMastodonCredentials(result.accessToken)).toMatchObject({ origin: ORIGIN, token: TOKEN, isDefault: false });
    const tokenCall = calls.find((c) => c.url === `${ORIGIN}/oauth/token`)!;
    expect(new URLSearchParams(tokenCall.init!.body).get("client_id")).toBe("cid-h");
    expect(tokenCall.init?.redirect).toBe("manual");
  });

  it("does not save anything when the instance refuses the code, and leaks no secret", async () => {
    handler = (url) => {
      if (url.endsWith("/api/v1/apps")) return real(200, { client_id: "c", client_secret: CLIENT_SECRET });
      return real(400, { error: "invalid_grant", error_description: `bad ${CLIENT_SECRET}` });
    };
    const err = (await adapter().exchangeCode("the-code", undefined, ORIGIN).catch((e: Error) => e)) as Error;
    expect(err.message).toBe("hachyderm.io refused the login (invalid_grant). Try connecting again.");
    noSecrets(err.message);
  });

  it("refuses an account name that is not a plain username", async () => {
    for (const name of ["a".repeat(65), "bad name", "x@evil.example", "../etc", "<b>"]) {
      handler = (url) => {
        if (url.endsWith("/api/v1/apps")) return real(200, { client_id: "c", client_secret: CLIENT_SECRET });
        if (url.endsWith("/oauth/token")) return real(200, { access_token: TOKEN });
        return real(200, { username: name });
      };
      const err = (await adapter().exchangeCode("c", undefined, ORIGIN).catch((e: Error) => e)) as Error;
      expect(err.message, name).toMatch(/account name LazyRelay cannot use/);
    }
  });

  it("invalid_client on a cached registration drops it and registers once more, then retries", async () => {
    apps.stored.set(ORIGIN, { clientId: "stale", clientSecret: "stale-secret" });
    let tokenCalls = 0;
    handler = (url, init) => {
      if (url === `${ORIGIN}/api/v1/apps`) return real(200, { client_id: "fresh", client_secret: CLIENT_SECRET });
      if (url === `${ORIGIN}/oauth/token`) {
        tokenCalls++;
        const id = new URLSearchParams(init!.body).get("client_id");
        return id === "stale" ? real(401, { error: "invalid_client" }) : real(200, { access_token: TOKEN });
      }
      return real(200, { username: "alice" });
    };
    const r = await adapter().exchangeCode("c", undefined, ORIGIN);
    expect(r.platformAccountId).toBe("alice@hachyderm.io");
    expect(tokenCalls).toBe(2);
    expect(apps.deleted).toEqual([ORIGIN]);
    expect(apps.stored.get(ORIGIN)?.clientId).toBe("fresh");
  });

  it("invalid_client twice gives up with a plain message (one re-registration only)", async () => {
    let tokenCalls = 0;
    handler = (url) => {
      if (url.endsWith("/api/v1/apps")) return real(200, { client_id: "c", client_secret: CLIENT_SECRET });
      tokenCalls++;
      return real(401, { error: "invalid_client" });
    };
    const err = (await adapter().exchangeCode("c", undefined, ORIGIN).catch((e: Error) => e)) as Error;
    expect(err.message).toBe("hachyderm.io refused the login (invalid_client). Try connecting again.");
    expect(tokenCalls).toBe(2);
  });

  it("fails rather than saving an account it could not identify", async () => {
    handler = (url) => {
      if (url.endsWith("/api/v1/apps")) return real(200, { client_id: "c", client_secret: CLIENT_SECRET });
      if (url.endsWith("/oauth/token")) return real(200, { access_token: TOKEN });
      return real(401, { error: "The access token is invalid" });
    };
    const err = (await adapter().exchangeCode("c", undefined, ORIGIN).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/did not confirm the account/);
    noSecrets(err.message);
  });

  it("user facing messages have no em or en dashes", async () => {
    handler = () => real(500, {});
    const messages: string[] = [];
    messages.push(((await adapter().getAuthorizeUrl("s", ORIGIN).catch((e: Error) => e)) as Error).message);
    messages.push(((await adapter().getAuthorizeUrl("s", "http://x.example").catch((e: Error) => e)) as Error).message);
    messages.push((await adapter().post(postReq("{bad"))).errorMessage ?? "");
    messages.push((await adapter().post(postReq(newCreds({ instance: "https://internal.example" })))).errorMessage ?? "");
    for (const m of messages) expect(m).not.toMatch(/[–—]/);
  });
});
