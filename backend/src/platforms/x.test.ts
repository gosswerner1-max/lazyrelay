// The X (bring-your-own-key) adapter: every method signs its own request from the stored bundle, malformed bundles
// never reach X, and no error carries a key. fetch is stubbed; nothing real is called.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../supabase.js", () => ({ supabase: {} }));
vi.mock("./streamUpload.js", () => ({ fetchMediaForStreaming: vi.fn(), buildStreamingMultipartBody: vi.fn() }));

import { fetchMediaForStreaming } from "./streamUpload.js";
import { XAdapter } from "./x.js";
import { X_BUNDLE_INVALID_CODE, parseXBundle, serializeXBundle, xKeyHint } from "./xByok.js";
import { X_TEST_BUNDLE, X_TEST_LOGIN } from "./xTestKit.js";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[];
let handler: (call: Call) => Response;
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  calls = [];
  handler = () => reply(200, {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body };
      calls.push(call);
      return handler(call);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const ALL_SECRETS = Object.values(X_TEST_BUNDLE);
const noSecretIn = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const s of ALL_SECRETS) expect(text).not.toContain(s);
};
const adapter = () => new XAdapter({ media: { sleep: async () => {} } });
const post = (over: Record<string, unknown> = {}) =>
  ({ socialAccountId: "sa1", content: "Hello X", mediaUrl: null, coverImageUrl: null, accessToken: X_TEST_LOGIN, ...over }) as never;
const mockImage = () =>
  (fetchMediaForStreaming as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => ({
    body: new Blob([url]).stream(),
    sizeBytes: url.length,
    contentType: "image/png",
  }));

describe("the stored bundle", () => {
  it("round-trips, and anything incomplete or foreign parses to null without throwing", () => {
    expect(parseXBundle(serializeXBundle(X_TEST_BUNDLE))).toEqual(X_TEST_BUNDLE);
    const bad = [
      null,
      undefined,
      "",
      "plain-oauth2-bearer-token",
      "{",
      "{}",
      '{"v":2}',
      JSON.stringify({ v: 1, apiKey: "a" }),
      JSON.stringify({ v: 1, ...X_TEST_BUNDLE, apiKey: "" }),
      JSON.stringify({ v: 1, ...X_TEST_BUNDLE, apiSecret: 5 }),
      "revoked",
    ];
    for (const b of bad) expect(parseXBundle(b as string)).toBeNull();
  });
  it("hints with the last four characters of the PUBLIC api key only, within the 8 character column", () => {
    expect(xKeyHint(X_TEST_BUNDLE.apiKey)).toBe("****abcd");
    expect(xKeyHint(X_TEST_BUNDLE.apiKey).length).toBeLessThanOrEqual(8);
  });
});

describe("the adapter declares itself bring-your-own-key", () => {
  it("is flagged byok, needs no confirmation step and has no OAuth redirect or refresh", async () => {
    const a = adapter();
    expect(a.byok).toBe(true);
    expect(a.skipConnectConfirmation).toBe(true);
    expect((a as { refresh?: unknown }).refresh).toBeUndefined();
    await expect(a.getAuthorizeUrl()).rejects.toThrow(/own developer keys/);
    await expect(a.exchangeCode()).rejects.toThrow(/own developer keys/);
  });
});

describe("post", () => {
  it("signs POST /2/tweets with OAuth 1.0a and sends the text as JSON", async () => {
    handler = () => reply(201, { data: { id: "t1", text: "Hello X" } });
    const r = await adapter().post(post());
    expect(r).toEqual({ success: true, platformPostId: "t1", errorMessage: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.x.com/2/tweets");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.Authorization).toMatch(/^OAuth /);
    expect(calls[0].headers.Authorization).toContain(`oauth_consumer_key="${X_TEST_BUNDLE.apiKey}"`);
    expect(calls[0].headers.Authorization).toContain(`oauth_token="${X_TEST_BUNDLE.accessToken}"`);
    expect(calls[0].headers.Authorization).not.toContain(X_TEST_BUNDLE.apiSecret);
    expect(calls[0].headers.Authorization).not.toContain(X_TEST_BUNDLE.accessTokenSecret);
    expect(calls[0].headers.Authorization).not.toMatch(/Bearer/);
    expect(JSON.parse(calls[0].body as string)).toEqual({ text: "Hello X" });
  });

  it("a stored login that is not a bundle sends nothing to X and says so with the fixed code", async () => {
    for (const accessToken of ["old-oauth2-bearer", "revoked", "{}"]) {
      const r = await adapter().post(post({ accessToken }));
      expect(r).toEqual({ success: false, platformPostId: null, errorMessage: X_BUNDLE_INVALID_CODE });
    }
    expect(calls).toHaveLength(0);
  });

  it("turns an X refusal into one compact line with X's own fields and no key", async () => {
    handler = () => reply(402, { title: "CreditsDepleted", type: "https://api.x.com/2/problems/credits", detail: `Your account has no credits ${X_TEST_BUNDLE.accessTokenSecret}` });
    const r = await adapter().post(post());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/^x_api_error status=402 /);
    expect(r.errorMessage).toContain("CreditsDepleted");
    noSecretIn(r);
  });

  it("carries the rate-limit reset time when X sends it", async () => {
    handler = () => reply(429, { title: "Too Many Requests", detail: "Too Many Requests" }, { "x-rate-limit-reset": "1893456000" });
    const r = await adapter().post(post());
    expect(r.errorMessage).toContain("status=429");
    expect(r.errorMessage).toContain("reset=1893456000");
  });

  it("a network failure is reported without a key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`socket hang up ${X_TEST_BUNDLE.apiSecret}`);
      }),
    );
    const r = await adapter().post(post());
    expect(r.success).toBe(false);
    noSecretIn(r);
  });

  it("uploads media through the selected flow, then attaches the ids", async () => {
    mockImage();
    handler = (c) => {
      if (c.url.endsWith("/2/media/upload/initialize")) return reply(200, { data: { id: "m1" } });
      if (c.url.includes("/2/media/upload/")) return reply(200, { data: {} });
      return reply(201, { data: { id: "t9" } });
    };
    const r = await adapter().post(post({ mediaUrl: "https://cdn.example.com/a.png" }));
    expect(r.success).toBe(true);
    const tweet = calls.find((c) => c.url.endsWith("/2/tweets"))!;
    expect(JSON.parse(tweet.body as string)).toEqual({ text: "Hello X", media: { media_ids: ["m1"] } });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.x.com/2/media/upload/initialize",
      "https://api.x.com/2/media/upload/m1/append",
      "https://api.x.com/2/media/upload/m1/finalize",
      "https://api.x.com/2/tweets",
    ]);
    for (const c of calls) expect(c.headers.Authorization).toMatch(/^OAuth /);
  });

  it("uses the v1.1 flow when the selector says so", async () => {
    mockImage();
    handler = (c) => {
      if (c.url.includes("command=INIT")) return reply(200, { media_id_string: "v1id" });
      if (c.url.includes("upload.twitter.com")) return reply(200, {});
      return reply(201, { data: { id: "t9" } });
    };
    const r = await new XAdapter({ mediaFlow: "v1.1" }).post(post({ mediaUrl: "https://cdn.example.com/a.png" }));
    expect(r.success).toBe(true);
    expect(calls[0].url).toContain("https://upload.twitter.com/1.1/media/upload.json?command=INIT");
    expect(JSON.parse(calls[calls.length - 1].body as string).media).toEqual({ media_ids: ["v1id"] });
  });

  it("a media refusal fails the post, creates no tweet and names X's reason", async () => {
    mockImage();
    handler = () => reply(403, { title: "Forbidden", type: "https://api.x.com/2/problems/oauth1-permissions", detail: "not allowed" });
    const r = await adapter().post(post({ mediaUrl: "https://cdn.example.com/a.png" }));
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("media initialize");
    expect(r.errorMessage).toContain("status=403");
    expect(calls.some((c) => c.url.endsWith("/2/tweets"))).toBe(false);
    noSecretIn(r);
  });
});

describe("postChainReply", () => {
  it("signs a reply with in_reply_to_tweet_id", async () => {
    handler = () => reply(201, { data: { id: "t2" } });
    const r = await adapter().postChainReply({ rootPostId: "r", parentPostId: "t1", text: "next", accessToken: X_TEST_LOGIN });
    expect(r).toEqual({ success: true, platformPostId: "t2", errorMessage: null });
    expect(calls[0].headers.Authorization).toMatch(/^OAuth /);
    expect(JSON.parse(calls[0].body as string)).toEqual({ text: "next", reply: { in_reply_to_tweet_id: "t1" } });
  });
  it("refuses a malformed bundle without calling X", async () => {
    const r = await adapter().postChainReply({ rootPostId: "r", parentPostId: "t1", text: "x", accessToken: "nope" });
    expect(r.errorMessage).toBe(X_BUNDLE_INVALID_CODE);
    expect(calls).toHaveLength(0);
  });
});

describe("verifyPublished and getPostMetrics", () => {
  it("verifyPublished signs GET /2/tweets/:id and checks the id", async () => {
    handler = () => reply(200, { data: { id: "t1" } });
    const r = await adapter().verifyPublished("t1", X_TEST_LOGIN);
    expect(r).toEqual({ verifiedLive: true, platformPostUrl: "https://x.com/i/status/t1", errorMessage: null });
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.x.com/2/tweets/t1");
    expect(calls[0].headers.Authorization).toMatch(/^OAuth /);
  });
  it("verifyPublished reports a refusal, and a bad bundle never reaches X", async () => {
    handler = () => reply(401, { title: "Unauthorized", detail: "Unauthorized" });
    const r = await adapter().verifyPublished("t1", X_TEST_LOGIN);
    expect(r.verifiedLive).toBe(false);
    expect(r.errorMessage).toContain("status=401");
    calls.length = 0;
    expect((await adapter().verifyPublished("t1", "nope")).errorMessage).toBe(X_BUNDLE_INVALID_CODE);
    expect(calls).toHaveLength(0);
  });
  it("getPostMetrics signs the query string and maps the counts", async () => {
    handler = () => reply(200, { data: { id: "t1", public_metrics: { like_count: 3, reply_count: 1, retweet_count: 2, impression_count: 40 } } });
    const m = await adapter().getPostMetrics("t1", X_TEST_LOGIN);
    expect(m).toEqual({ likes: 3, comments: 1, shares: 2, views: 40, errorMessage: null });
    expect(calls[0].url).toBe("https://api.x.com/2/tweets/t1?tweet.fields=public_metrics");
    expect(calls[0].headers.Authorization).toMatch(/^OAuth /);
    const bad = await adapter().getPostMetrics("t1", "nope");
    expect(bad).toEqual({ likes: null, comments: null, shares: null, views: null, errorMessage: X_BUNDLE_INVALID_CODE });
  });
});

describe("verifyKeys (the keys route's check)", () => {
  const bundle = X_TEST_BUNDLE;
  it("returns the account the four values belong to", async () => {
    handler = () => reply(200, { data: { id: "42", username: "acme", name: "Acme" } });
    expect(await adapter().verifyKeys(bundle)).toEqual({ ok: true, id: "42", username: "acme", name: "Acme" });
    expect(calls[0].url).toBe("https://api.x.com/2/users/me");
    expect(calls[0].headers.Authorization).toMatch(/^OAuth /);
  });
  it("maps each kind of refusal to a short reason", async () => {
    const cases: Array<[number, unknown, string]> = [
      [401, { title: "Unauthorized" }, "invalid"],
      [402, { title: "CreditsDepleted" }, "out_of_credit"],
      [403, { title: "Forbidden", detail: "usage-capped" }, "out_of_credit"],
      [403, { title: "Forbidden" }, "forbidden"],
      [429, { title: "Too Many Requests" }, "rate_limited"],
      [503, {}, "unreachable"],
    ];
    for (const [status, body, reason] of cases) {
      handler = () => reply(status, body);
      expect(await adapter().verifyKeys(bundle)).toEqual({ ok: false, reason });
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    expect(await adapter().verifyKeys(bundle)).toEqual({ ok: false, reason: "unreachable" });
  });
});
