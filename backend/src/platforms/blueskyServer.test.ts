// Bluesky accounts hosted on a server other than bsky.social (master list #11), and proof that
// accounts connected the old way (bare tokens) behave exactly as before. fetch and the SSRF
// guard are stubbed; nothing real is called and no real credentials appear.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../supabase.js", () => ({ supabase: {} }));
vi.mock("../urlSafety.js", () => ({
  isSafeMediaUrl: vi.fn(async (url: string) =>
    new URL(url).hostname.startsWith("internal")
      ? { safe: false, reason: "must not point at a private, internal, or reserved address" }
      : { safe: true, addresses: ["93.184.216.34"] },
  ),
}));
vi.mock("./streamUpload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./streamUpload.js")>();
  return { ...actual, fetchMediaForStreaming: vi.fn() };
});

import { isSafeMediaUrl } from "../urlSafety.js";
import { fetchMediaForStreaming } from "./streamUpload.js";
import { BlueskyAdapter, parseBlueskyToken } from "./bluesky.js";

const JWT = "jwt-access-secret";
const REFRESH = "jwt-refresh-secret";
const PASSWORD = "app-password-not-real";
const PDS = "https://pds.example.com";
const DID = "did:plc:abc123";
const wrapped = (token: string, server = PDS) => JSON.stringify({ server, token });

type Call = { url: string; init: Record<string, any> | undefined };
let calls: Call[];
let handler: (url: string, init: Record<string, any> | undefined) => unknown;

const real = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fake = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

const adapter = () => new BlueskyAdapter("https://app.example.org/connect");
const postReq = (accessToken: string, over: Record<string, unknown> = {}) =>
  ({ socialAccountId: "sa1", content: "Hello", mediaUrl: null, coverImageUrl: null, accessToken, ...over }) as never;
const connectCode = (over: Record<string, unknown> = {}) => JSON.stringify({ identifier: "alice.example.com", password: PASSWORD, ...over });

beforeEach(() => {
  calls = [];
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
  for (const s of [JWT, REFRESH, PASSWORD]) expect(text ?? "").not.toContain(s);
};

describe("parseBlueskyToken", () => {
  it("a bare JWT is the old format: bsky.social", () => {
    expect(parseBlueskyToken(JWT)).toEqual({ pds: "https://bsky.social", token: JWT, isDefault: true });
  });
  it("the JSON names the server; bsky.social inside it is still the default path", () => {
    expect(parseBlueskyToken(wrapped(JWT))).toEqual({ pds: PDS, token: JWT, isDefault: false });
    expect(parseBlueskyToken(wrapped(JWT, "https://bsky.social")).isDefault).toBe(true);
  });
  it("damaged JSON is refused with a plain message", () => {
    for (const bad of ["{oops", JSON.stringify({ server: PDS }), wrapped(JWT, "http://pds.example.com"), wrapped("")]) {
      expect(() => parseBlueskyToken(bad)).toThrow(/damaged/);
    }
  });
});

describe("old-format accounts (bare tokens) are unchanged", () => {
  const plain = (c: Call, url: string) => {
    expect(c.url).toBe(url);
    expect(c.init).not.toHaveProperty("redirect");
    expect(c.init).not.toHaveProperty("dispatcher");
    expect(c.init).not.toHaveProperty("signal");
  };

  it("connecting without a server is the old flow and stores bare tokens", async () => {
    handler = (url) => {
      if (url === "https://bsky.social/xrpc/com.atproto.server.createSession") return fake(200, { accessJwt: JWT, refreshJwt: REFRESH, did: DID, handle: "alice.example.com" });
      return fake(200, { displayName: "Alice" });
    };
    const r = await adapter().exchangeCode(connectCode());
    expect(r).toMatchObject({ accessToken: JWT, refreshToken: REFRESH, platformAccountId: DID, displayName: "Alice" });
    plain(calls[0], "https://bsky.social/xrpc/com.atproto.server.createSession");
    expect(JSON.parse(calls[0].init!.body)).toEqual({ identifier: "alice.example.com", password: PASSWORD });
    expect(isSafeMediaUrl).not.toHaveBeenCalled();
  });

  it("an empty server, or bsky.social typed out, is the same old flow", async () => {
    handler = (url) => (url.includes("createSession") ? fake(200, { accessJwt: JWT, refreshJwt: REFRESH, did: DID }) : fake(200, {}));
    for (const server of ["", "   ", "bsky.social", "https://bsky.social/"]) {
      calls = [];
      const r = await adapter().exchangeCode(connectCode({ server }));
      expect(r.accessToken).toBe(JWT);
      expect(r.refreshToken).toBe(REFRESH);
      plain(calls[0], "https://bsky.social/xrpc/com.atproto.server.createSession");
    }
  });

  it("refresh, post, verify, reply-to-comment, thread reply and follower count all use bsky.social with the bare token", async () => {
    handler = (url) => {
      if (url.endsWith("refreshSession")) return fake(200, { accessJwt: "new-access", refreshJwt: "new-refresh" });
      if (url.endsWith("getSession")) return fake(200, { did: DID, emailConfirmed: true });
      if (url.endsWith("createRecord")) return fake(200, { uri: `at://${DID}/app.bsky.feed.post/r1`, cid: "c1" });
      if (url.includes("getRecord")) return fake(200, { uri: `at://${DID}/app.bsky.feed.post/r1`, cid: "c1" });
      if (url.includes("getPostThread")) return fake(200, { thread: { post: { uri: "at://x/y/z", cid: "cz" } } });
      if (url.includes("getProfile")) return fake(200, { followersCount: 9 });
      return fake(404, {});
    };
    const a = adapter();

    const refreshed = await a.refresh(REFRESH);
    expect(refreshed).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
    plain(calls[0], "https://bsky.social/xrpc/com.atproto.server.refreshSession");
    expect(calls[0].init?.headers.Authorization).toBe(`Bearer ${REFRESH}`);

    calls = [];
    const posted = await a.post(postReq(JWT));
    expect(posted).toEqual({ success: true, platformPostId: `at://${DID}/app.bsky.feed.post/r1`, errorMessage: null });
    plain(calls[0], "https://bsky.social/xrpc/com.atproto.server.getSession");
    plain(calls[1], "https://bsky.social/xrpc/com.atproto.repo.createRecord");
    expect(calls[1].init?.headers.Authorization).toBe(`Bearer ${JWT}`);

    calls = [];
    const v = await a.verifyPublished(`at://${DID}/app.bsky.feed.post/r1`, JWT);
    expect(v.verifiedLive).toBe(true);
    plain(calls[0], `https://bsky.social/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(DID)}&collection=app.bsky.feed.post&rkey=r1`);

    calls = [];
    expect(await a.replyToComment("at://x/y/z", "thanks", JWT)).toMatchObject({ success: true, errorMessage: null, platformReplyId: expect.any(String) });
    expect(calls.map((c) => c.url)).toEqual([
      "https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at%3A%2F%2Fx%2Fy%2Fz&depth=0&parentHeight=10",
      "https://bsky.social/xrpc/com.atproto.server.getSession",
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
    ]);

    calls = [];
    const chain = await a.postChainReply({ rootPostId: `at://${DID}/app.bsky.feed.post/r1`, parentPostId: `at://${DID}/app.bsky.feed.post/r1`, text: "more", accessToken: JWT });
    expect(chain.success).toBe(true);
    for (const c of calls) plain(c, c.url);
    expect(calls.every((c) => c.url.startsWith("https://bsky.social/"))).toBe(true);

    calls = [];
    expect(await a.getFollowerCount(JWT)).toBe(9);
    plain(calls[0], "https://bsky.social/xrpc/com.atproto.server.getSession");
    expect(isSafeMediaUrl).not.toHaveBeenCalled();
  });

  it("image upload goes to bsky.social with no guard", async () => {
    (fetchMediaForStreaming as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
      sizeBytes: 3,
      contentType: "image/png",
    }));
    handler = (url) => {
      if (url.endsWith("getSession")) return fake(200, { did: DID });
      if (url.endsWith("uploadBlob")) return fake(200, { blob: { $type: "blob", ref: { $link: "l" }, mimeType: "image/png", size: 3 } });
      return fake(200, { uri: `at://${DID}/app.bsky.feed.post/r1` });
    };
    const r = await adapter().post(postReq(JWT, { mediaUrl: "https://cdn.example.com/a.png" }));
    expect(r.success).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "https://bsky.social/xrpc/com.atproto.server.getSession",
      "https://bsky.social/xrpc/com.atproto.repo.uploadBlob",
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
    ]);
    for (const c of calls) expect(c.init).not.toHaveProperty("dispatcher");
  });

  it("a network failure still propagates as the same thrown error", async () => {
    handler = () => Promise.reject(new Error("socket hang up"));
    await expect(adapter().post(postReq(JWT))).rejects.toThrow("socket hang up");
  });
});

describe("accounts hosted on another server", () => {
  const guarded = (c: Call, url: string, token = JWT) => {
    expect(c.url).toBe(url);
    expect(c.init?.redirect).toBe("manual");
    expect(c.init?.dispatcher).toBeDefined();
    expect(c.init?.signal).toBeDefined();
    if (c.init?.headers?.Authorization) expect(c.init.headers.Authorization).toBe(`Bearer ${token}`);
  };

  it("connect: createSession goes to that server, guarded, and both tokens are stored wrapped", async () => {
    handler = (url) => {
      if (url === `${PDS}/xrpc/com.atproto.server.createSession`) return real(200, { accessJwt: JWT, refreshJwt: REFRESH, did: DID, handle: "alice.example.com" });
      return real(200, { displayName: "Alice" });
    };
    const r = await adapter().exchangeCode(connectCode({ server: "PDS.example.com" }));
    guarded(calls[0], `${PDS}/xrpc/com.atproto.server.createSession`);
    expect(JSON.parse(calls[0].init!.body)).toEqual({ identifier: "alice.example.com", password: PASSWORD });
    expect(r.accessToken).toBe(wrapped(JWT));
    expect(r.refreshToken).toBe(wrapped(REFRESH));
    expect(r.platformAccountId).toBe(DID);
    expect(parseBlueskyToken(r.accessToken)).toMatchObject({ pds: PDS, token: JWT, isDefault: false });
  });

  it("connect refuses a bad or blocked server before anything is sent", async () => {
    handler = () => real(200, {});
    await expect(adapter().exchangeCode(connectCode({ server: "http://pds.example.com" }))).rejects.toThrow(/https/);
    await expect(adapter().exchangeCode(connectCode({ server: "pds.example.com/xrpc" }))).rejects.toThrow(/without a path/);
    await expect(adapter().exchangeCode(connectCode({ server: "https://internal.example" }))).rejects.toThrow(/not allowed/);
    expect(calls).toHaveLength(0);
  });

  it("connect failure messages hold no password or token", async () => {
    handler = () => real(401, { error: "AuthenticationRequired", message: "Invalid identifier or password" });
    const err = (await adapter().exchangeCode(connectCode({ server: PDS })).catch((e: Error) => e)) as Error;
    expect(err.message).toBe("Invalid identifier or password");
    noSecrets(err.message);

    handler = () => Promise.reject(new Error(`boom ${PASSWORD}`));
    const err2 = (await adapter().exchangeCode(connectCode({ server: PDS })).catch((e: Error) => e)) as Error;
    expect(err2.message).toBe("Could not reach pds.example.com. Check the server address and try again later.");
    noSecrets(err2.message);
  });

  it("refresh goes to the account's own server and keeps the wrapping", async () => {
    handler = () => real(200, { accessJwt: "new-access", refreshJwt: "new-refresh" });
    const r = await adapter().refresh(wrapped(REFRESH));
    guarded(calls[0], `${PDS}/xrpc/com.atproto.server.refreshSession`, REFRESH);
    expect(r.accessToken).toBe(wrapped("new-access"));
    expect(r.refreshToken).toBe(wrapped("new-refresh"));
  });

  it("refresh with a damaged stored token fails plainly", async () => {
    await expect(adapter().refresh("{bad")).rejects.toThrow(/damaged/);
  });

  it("post, verify, reply, thread reply and follower count all use that server and only the inner token", async () => {
    handler = (url) => {
      if (url.endsWith("getSession")) return real(200, { did: DID, emailConfirmed: true });
      if (url.endsWith("createRecord")) return real(200, { uri: `at://${DID}/app.bsky.feed.post/r1`, cid: "c1" });
      if (url.includes("getRecord")) return real(200, { uri: `at://${DID}/app.bsky.feed.post/r1`, cid: "c1" });
      if (url.includes("getPostThread")) return real(200, { thread: { post: { uri: "at://x/y/z", cid: "cz" } } });
      if (url.includes("getProfile")) return real(200, { followersCount: 4 });
      return real(404, {});
    };
    const a = adapter();
    const tok = wrapped(JWT);

    expect((await a.post(postReq(tok))).success).toBe(true);
    guarded(calls[0], `${PDS}/xrpc/com.atproto.server.getSession`);
    guarded(calls[1], `${PDS}/xrpc/com.atproto.repo.createRecord`);
    expect(JSON.parse(calls[1].init!.body).repo).toBe(DID);

    calls = [];
    expect((await a.verifyPublished(`at://${DID}/app.bsky.feed.post/r1`, tok)).verifiedLive).toBe(true);
    guarded(calls[0], `${PDS}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(DID)}&collection=app.bsky.feed.post&rkey=r1`);

    calls = [];
    expect(await a.replyToComment("at://x/y/z", "thanks", tok)).toMatchObject({ success: true, errorMessage: null, platformReplyId: expect.any(String) });
    // The thread lookup is the shared public service, the session and record go to the account's server.
    expect(calls[0].url).toContain("https://public.api.bsky.app/");
    guarded(calls[1], `${PDS}/xrpc/com.atproto.server.getSession`);
    guarded(calls[2], `${PDS}/xrpc/com.atproto.repo.createRecord`);

    calls = [];
    const uri = `at://${DID}/app.bsky.feed.post/r1`;
    expect((await a.postChainReply({ rootPostId: uri, parentPostId: uri, text: "more", accessToken: tok })).success).toBe(true);
    for (const c of calls) guarded(c, c.url);
    expect(calls.every((c) => c.url.startsWith(`${PDS}/`))).toBe(true);

    calls = [];
    expect(await a.getFollowerCount(tok)).toBe(4);
    guarded(calls[0], `${PDS}/xrpc/com.atproto.server.getSession`);
    expect(calls[1].url).toContain("https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile");
  });

  it("image upload goes to that server, guarded", async () => {
    (fetchMediaForStreaming as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
      sizeBytes: 3,
      contentType: "image/png",
    }));
    handler = (url) => {
      if (url.endsWith("getSession")) return real(200, { did: DID });
      if (url.endsWith("uploadBlob")) return real(200, { blob: { $type: "blob", ref: { $link: "l" }, mimeType: "image/png", size: 3 } });
      return real(200, { uri: `at://${DID}/app.bsky.feed.post/r1` });
    };
    const r = await adapter().post(postReq(wrapped(JWT), { mediaUrl: "https://cdn.example.com/a.png" }));
    expect(r.success).toBe(true);
    guarded(calls[1], `${PDS}/xrpc/com.atproto.repo.uploadBlob`);
    expect(calls[1].init?.duplex).toBe("half");
  });

  it("an address the guard refuses is never contacted, on every method", async () => {
    handler = () => real(200, {});
    const tok = wrapped(JWT, "https://internal.example");
    const a = adapter();
    expect((await a.post(postReq(tok))).errorMessage).toMatch(/not allowed/);
    expect((await a.verifyPublished(`at://${DID}/app.bsky.feed.post/r1`, tok)).errorMessage).toMatch(/not allowed/);
    expect((await a.postChainReply({ rootPostId: "at://a/b/c", parentPostId: "at://a/b/c", text: "t", accessToken: tok })).errorMessage).toMatch(/not allowed/);
    expect(await a.getFollowerCount(tok)).toBeNull();
    expect(calls.filter((c) => c.url.includes("internal.example"))).toHaveLength(0);
  });

  it("a dropped connection or damaged token becomes a plain message with no secret", async () => {
    handler = () => Promise.reject(new Error(`connect failed Bearer ${JWT}`));
    const r = await adapter().post(postReq(wrapped(JWT)));
    expect(r.errorMessage).toBe("Could not reach pds.example.com. Check the server address and try again later.");
    noSecrets(r.errorMessage);
    expect((await adapter().post(postReq("{bad"))).errorMessage).toMatch(/damaged/);
    expect((await adapter().verifyPublished("at://a/b/c", "{bad")).errorMessage).toMatch(/damaged/);
    expect((await adapter().replyToComment("x", "y", "{bad")).errorMessage).toMatch(/damaged/);
  });

  it("server text is cut and user facing messages have no em or en dashes", async () => {
    handler = () => real(400, { message: "m".repeat(2000) });
    const r = await adapter().post(postReq(wrapped(JWT)));
    expect(r.errorMessage).toHaveLength(300);
    const others = [
      (await adapter().post(postReq("{bad"))).errorMessage ?? "",
      (await adapter().exchangeCode(connectCode({ server: "http://x.example" })).catch((e: Error) => e.message)) as string,
    ];
    for (const m of others) expect(m).not.toMatch(/[–—]/);
  });
});
