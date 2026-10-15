// test-x-byok-mock: local verification of the X bring-your-own-key code paths against a MOCKED X. No network at all:
// fetch is injected or stubbed, and the global fetch is made to throw if anything reaches for the real one. Run it with
//   npm run test:x-byok-mock
//
// It proves how the code REACTS to the answers X is documented to give (success, 401, 402, 403, 429, 5xx, garbage), for
// the text post, the v2 media flow, the v1.1 fallback flow, a post with media, a reply, and that every request is OAuth
// 1.0a signed. It proves NOTHING about what live X accepts: media upload is UNVERIFIED against live X with OAuth 1.0a.
//
// No assertion here ever prints a key: secrets are only compared through booleans.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../supabase.js", () => ({ supabase: {} }));
vi.mock("../notify.js", () => ({ notifyOps: vi.fn() }));
vi.mock("../email.js", () => ({ sendReconnectNeededEmail: vi.fn() }));
vi.mock("../webhook.js", () => ({ dispatchWebhookEvent: vi.fn() }));
vi.mock("./streamUpload.js", () => ({ fetchMediaForStreaming: vi.fn(), buildStreamingMultipartBody: vi.fn() }));

import { fetchMediaForStreaming } from "./streamUpload.js";
import { classifyPostError, X_BYOK_CREDIT_MESSAGE, X_BYOK_INVALID_KEYS_MESSAGE, X_BYOK_PERMISSION_MESSAGE } from "../postErrors.js";
import { XAdapter } from "./x.js";
import { createXMediaUploader, X_MEDIA_UPLOAD_CONFIG, type XMediaFlow } from "./xMedia.js";
import { X_TEST_BUNDLE, X_TEST_LOGIN } from "./xTestKit.js";

const SECRETS = Object.values(X_TEST_BUNDLE);
const leaksSecret = (value: unknown): boolean => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return SECRETS.some((s) => text.includes(s));
};

type Seen = { url: string; method: string; auth: string; body: unknown };
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const raw = (status: number, text: string) => new Response(text, { status });

/** The failure answers X is documented to give, and the class + key status each must produce. */
const FAILURES: Array<{ name: string; make: () => Response; kind: "reconnect" | "fatal" | "retry"; byokStatus?: "invalid" | "out_of_credit"; message?: string }> = [
  { name: "401 unauthorized", make: () => reply(401, { title: "Unauthorized", type: "about:blank", status: 401, detail: "Unauthorized" }), kind: "reconnect", byokStatus: "invalid", message: X_BYOK_INVALID_KEYS_MESSAGE },
  { name: "402 credits depleted", make: () => reply(402, { title: "CreditsDepleted", type: "https://api.x.com/2/problems/credits", detail: "no credits" }), kind: "fatal", byokStatus: "out_of_credit", message: X_BYOK_CREDIT_MESSAGE },
  { name: "403 client-forbidden", make: () => reply(403, { title: "Client Forbidden", type: "https://api.x.com/2/problems/client-forbidden", detail: "Your client app is not configured with the appropriate oauth1 app permissions" }), kind: "fatal", message: X_BYOK_PERMISSION_MESSAGE },
  { name: "403 naming credits", make: () => reply(403, { title: "Forbidden", detail: "Your account has no credits or hit its spending limit" }), kind: "fatal", byokStatus: "out_of_credit", message: X_BYOK_CREDIT_MESSAGE },
  { name: "429 usage-capped", make: () => reply(429, { title: "UsageCapped", type: "https://api.x.com/2/problems/usage-capped", detail: "Usage cap exceeded" }), kind: "fatal", byokStatus: "out_of_credit", message: X_BYOK_CREDIT_MESSAGE },
  { name: "429 rate-limit-exceeded", make: () => reply(429, { title: "Too Many Requests", detail: "Too Many Requests" }, { "x-rate-limit-reset": "1893456000" }), kind: "retry" },
  { name: "500 server error", make: () => reply(500, { title: "Internal Server Error", detail: "Internal Server Error" }), kind: "retry" },
  { name: "503 unavailable", make: () => reply(503, { title: "Service Unavailable" }), kind: "retry" },
  { name: "502 with a garbage body", make: () => raw(502, "<html>Bad Gateway</html>"), kind: "retry" },
];

let seen: Seen[];
let route: (url: string, method: string, body: unknown) => Response;
beforeEach(() => {
  seen = [];
  route = () => reply(200, {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!/^https:\/\/(api\.x\.com|upload\.twitter\.com)\//.test(url)) throw new Error("mock suite: a request left X's hosts");
      const method = init?.method ?? "GET";
      seen.push({ url, method, auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? "", body: init?.body });
      return route(url, method, init?.body);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const adapter = () => new XAdapter({ media: { sleep: async () => {} } });
const req = (over: Record<string, unknown> = {}) =>
  ({ socialAccountId: "sa1", content: "Hello X", mediaUrl: null, coverImageUrl: null, accessToken: X_TEST_LOGIN, ...over }) as never;

describe("(a) text-only post", () => {
  it("201 succeeds and returns the post id", async () => {
    route = () => reply(201, { data: { id: "111", text: "Hello X" } });
    expect(await adapter().post(req())).toEqual({ success: true, platformPostId: "111", errorMessage: null });
  });

  for (const f of FAILURES) {
    it(`${f.name}: class ${f.kind}${f.byokStatus ? `, key status ${f.byokStatus}` : ""}, no secret in the error`, async () => {
      route = () => f.make();
      const r = await adapter().post(req());
      expect(r.success).toBe(false);
      expect(leaksSecret(r)).toBe(false);
      const c = classifyPostError("x_byok", r.errorMessage ?? "");
      expect(c.kind).toBe(f.kind);
      expect(c.byokStatus).toBe(f.byokStatus);
      if (f.message) expect(c.message).toBe(f.message);
      expect(leaksSecret(c)).toBe(false);
    });
  }

  it("429 rate-limit-exceeded carries X's reset time through to a not-before retry time", async () => {
    route = () => FAILURES.find((f) => f.name === "429 rate-limit-exceeded")!.make();
    const r = await adapter().post(req());
    expect(classifyPostError("x_byok", r.errorMessage ?? "").retryNotBefore).toBe(1893456000 * 1000);
  });

  it("malformed JSON on a 200 is a failure, not a crash, and leaks nothing", async () => {
    route = () => raw(200, "{not json");
    const r = await adapter().post(req());
    expect(r.success).toBe(false);
    expect(leaksSecret(r)).toBe(false);
    expect(classifyPostError("x_byok", r.errorMessage ?? "").kind).toBe("retry");
  });

  it("a thrown network error never carries a key in the result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`boom ${X_TEST_BUNDLE.accessTokenSecret}`); }));
    const r = await adapter().post(req());
    expect(r.success).toBe(false);
    expect(leaksSecret(r)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (b) media upload, both flows

const FLOWS: XMediaFlow[] = ["v2", "v1.1"];
const png = { bytes: Buffer.from("0123456789abcdefghij0123456789abcdefghij"), mimeType: "image/png" }; // 40 bytes
const tiny = { maxSegmentBytes: 16, statusPollMaxAttempts: 4, statusPollIntervalMs: 1 }; // 40 bytes -> 3 segments

/** A mock X media server for one flow. `fail` makes one named step answer with a failure instead. */
function mediaServer(flow: XMediaFlow, opts: { fail?: { step: "initialize" | "append" | "finalize" | "status"; make: () => Response }; processing?: Array<"pending" | "in_progress" | "succeeded" | "failed"> } = {}) {
  const states = [...(opts.processing ?? [])];
  return (url: string): Response => {
    const v2 = flow === "v2";
    const step = v2
      ? url.endsWith("/initialize") ? "initialize" : url.endsWith("/append") ? "append" : url.endsWith("/finalize") ? "finalize" : "status"
      : url.includes("command=INIT") ? "initialize" : url.includes("command=FINALIZE") ? "finalize" : url.includes("command=STATUS") ? "status" : "append";
    if (opts.fail && opts.fail.step === step) return opts.fail.make();
    if (step === "initialize") return v2 ? reply(200, { data: { id: "777", media_key: "3_777" } }) : reply(200, { media_id_string: "777" });
    if (step === "append") return v2 ? reply(200, { data: { expires_at: 1 } }) : new Response(null, { status: 204 });
    if (step === "finalize") {
      const info = states.length ? { processing_info: { state: states.shift(), check_after_secs: 1 } } : {};
      return v2 ? reply(200, { data: { id: "777", ...info } }) : reply(200, { media_id_string: "777", ...info });
    }
    const state = states.shift() ?? "succeeded";
    const info = { processing_info: state === "succeeded" ? { state } : { state, check_after_secs: 1 } };
    return v2 ? reply(200, { data: { id: "777", ...info } }) : reply(200, { media_id_string: "777", ...info });
  };
}

function uploaderFor(flow: XMediaFlow, handler: (url: string) => Response, seenOut: Seen[]) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seenOut.push({ url, method: init.method ?? "GET", auth: (init.headers as Record<string, string>).Authorization, body: init.body });
    return handler(url);
  }) as never;
  return createXMediaUploader(flow, X_TEST_BUNDLE, { fetchImpl, sleep: async () => {}, config: tiny });
}

for (const flow of FLOWS) {
  describe(`(b) media upload, ${flow} flow (UNVERIFIED against live X)`, () => {
    it("initialize, multi-segment append, finalize: a payload bigger than one segment is split in order", async () => {
      const out: Seen[] = [];
      const r = await uploaderFor(flow, mediaServer(flow), out).upload(png);
      expect(r).toMatchObject({ ok: true, mediaId: "777" });
      const appends = out.filter((c) => c.body instanceof FormData);
      expect(appends).toHaveLength(3);
      expect(appends.map((c) => (c.body as FormData).get("segment_index"))).toEqual(["0", "1", "2"]);
      const sizes = appends.map((c) => ((c.body as FormData).get("media") as Blob).size);
      expect(sizes).toEqual([16, 16, 8]);
      expect(out.length).toBe(1 + 3 + 1); // initialize + 3 appends + finalize
    });

    it("the real default segment size is 8 MiB, so a payload just over it also splits in two", async () => {
      const out: Seen[] = [];
      const fetchImpl = (async (url: string, init: RequestInit) => {
        out.push({ url, method: init.method ?? "GET", auth: "", body: init.body });
        return mediaServer(flow)(url);
      }) as never;
      const big = { bytes: Buffer.alloc(X_MEDIA_UPLOAD_CONFIG.maxSegmentBytes + 1), mimeType: "image/jpeg" };
      const r = await createXMediaUploader(flow, X_TEST_BUNDLE, { fetchImpl, sleep: async () => {} }).upload(big);
      expect(r.ok).toBe(true);
      expect(out.filter((c) => c.body instanceof FormData)).toHaveLength(2);
    });

    it("polls status: pending then succeeded", async () => {
      const out: Seen[] = [];
      const r = await uploaderFor(flow, mediaServer(flow, { processing: ["pending", "in_progress", "succeeded"] }), out).upload({ bytes: Buffer.from("video"), mimeType: "video/mp4" });
      expect(r).toMatchObject({ ok: true, mediaId: "777" });
      expect(out.filter((c) => c.url.includes("STATUS")).length).toBe(2);
    });

    it("polls status: processing that fails stops the upload at the status step", async () => {
      const out: Seen[] = [];
      const r = await uploaderFor(flow, mediaServer(flow, { processing: ["pending", "failed"] }), out).upload({ bytes: Buffer.from("video"), mimeType: "video/mp4" });
      expect(r).toMatchObject({ ok: false, failedStep: "status" });
      expect(leaksSecret(r)).toBe(false);
    });

    it("polls status: gives up after the configured number of attempts", async () => {
      const out: Seen[] = [];
      const r = await uploaderFor(flow, mediaServer(flow, { processing: ["pending", "pending", "pending", "pending", "pending", "pending", "pending", "pending"] }), out).upload({ bytes: Buffer.from("video"), mimeType: "video/mp4" });
      expect(r).toMatchObject({ ok: false, failedStep: "status" });
      expect(out.filter((c) => c.url.includes("STATUS")).length).toBe(tiny.statusPollMaxAttempts);
    });

    for (const step of ["initialize", "append", "finalize", "status"] as const) {
      for (const f of FAILURES) {
        it(`${step} answered with ${f.name}: failed at ${step}, class ${f.kind}${f.byokStatus ? `, status ${f.byokStatus}` : ""}, no secret`, async () => {
          const out: Seen[] = [];
          const processing = step === "status" ? (["pending", "succeeded"] as const) : undefined;
          const r = await uploaderFor(flow, mediaServer(flow, { fail: { step, make: f.make }, processing: processing ? [...processing] : undefined }), out).upload(png);
          expect(r.ok).toBe(false);
          if (r.ok) return;
          expect(r.failedStep).toBe(step);
          expect(leaksSecret(r)).toBe(false);
          const c = classifyPostError("x_byok", r.errorMessage);
          expect(c.kind).toBe(f.kind);
          expect(c.byokStatus).toBe(f.byokStatus);
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// (c) post with media, reply/chain post

describe("(c) post with a media id, and a chain reply", () => {
  const image = () =>
    (fetchMediaForStreaming as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => ({ body: new Blob([url]).stream(), sizeBytes: url.length, contentType: "image/png" }));

  for (const flow of FLOWS) {
    it(`${flow}: uploads, then the tweet carries the media id`, async () => {
      image();
      const server = mediaServer(flow);
      route = (url) => (url.endsWith("/2/tweets") ? reply(201, { data: { id: "900" } }) : server(url));
      const r = await new XAdapter({ mediaFlow: flow, media: { sleep: async () => {} } }).post(req({ mediaUrl: "https://cdn.example.com/a.png" }));
      expect(r).toEqual({ success: true, platformPostId: "900", errorMessage: null });
      const tweet = seen.find((s) => s.url.endsWith("/2/tweets"))!;
      expect(JSON.parse(tweet.body as string)).toEqual({ text: "Hello X", media: { media_ids: ["777"] } });
    });

    it(`${flow}: a media failure creates no tweet and classifies like any other X failure`, async () => {
      image();
      const server = mediaServer(flow, { fail: { step: "finalize", make: FAILURES[1].make } });
      route = (url) => (url.endsWith("/2/tweets") ? reply(201, { data: { id: "900" } }) : server(url));
      const r = await new XAdapter({ mediaFlow: flow, media: { sleep: async () => {} } }).post(req({ mediaUrl: "https://cdn.example.com/a.png" }));
      expect(r.success).toBe(false);
      expect(seen.some((s) => s.url.endsWith("/2/tweets"))).toBe(false);
      expect(classifyPostError("x_byok", r.errorMessage ?? "")).toMatchObject({ kind: "fatal", byokStatus: "out_of_credit" });
      expect(leaksSecret(r)).toBe(false);
    });
  }

  it("a chain reply replies to the previous post", async () => {
    route = () => reply(201, { data: { id: "901" } });
    const r = await adapter().postChainReply({ rootPostId: "900", parentPostId: "900", text: "and more", accessToken: X_TEST_LOGIN });
    expect(r).toEqual({ success: true, platformPostId: "901", errorMessage: null });
    expect(JSON.parse(seen[0].body as string)).toEqual({ text: "and more", reply: { in_reply_to_tweet_id: "900" } });
  });

  for (const f of FAILURES) {
    it(`a chain reply answered with ${f.name}: class ${f.kind}, no secret`, async () => {
      route = () => f.make();
      const r = await adapter().postChainReply({ rootPostId: "900", parentPostId: "900", text: "x", accessToken: X_TEST_LOGIN });
      expect(r.success).toBe(false);
      expect(leaksSecret(r)).toBe(false);
      expect(classifyPostError("x_byok", r.errorMessage ?? "").kind).toBe(f.kind);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// (d) every request is OAuth 1.0a signed

describe("(d) every request carries a well-formed OAuth 1.0a Authorization header", () => {
  const HEADER = /^OAuth oauth_consumer_key="[^"]+", oauth_nonce="[^"]+", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="\d{10}", oauth_token="[^"]+", oauth_version="1\.0"$/;
  const field = (auth: string, name: string) => decodeURIComponent(new RegExp(`${name}="([^"]+)"`).exec(auth)?.[1] ?? "");

  it("covers verifyKeys, post, media (both flows), a reply, verify and metrics", async () => {
    (fetchMediaForStreaming as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => ({ body: new Blob([url]).stream(), sizeBytes: url.length, contentType: "image/png" }));
    const servers = { v2: mediaServer("v2"), "v1.1": mediaServer("v1.1") };
    route = (url) => {
      if (url.endsWith("/2/users/me")) return reply(200, { data: { id: "1", username: "acme" } });
      if (url.endsWith("/2/tweets")) return reply(201, { data: { id: "900" } });
      if (url.includes("/2/tweets/")) return reply(200, { data: { id: "900", public_metrics: {} } });
      return url.includes("upload.twitter.com") ? servers["v1.1"](url) : servers.v2(url);
    };
    await adapter().verifyKeys(X_TEST_BUNDLE);
    for (const flow of FLOWS) await new XAdapter({ mediaFlow: flow, media: { sleep: async () => {} } }).post(req({ mediaUrl: "https://cdn.example.com/a.png" }));
    await adapter().postChainReply({ rootPostId: "900", parentPostId: "900", text: "x", accessToken: X_TEST_LOGIN });
    await adapter().verifyPublished("900", X_TEST_LOGIN);
    await adapter().getPostMetrics("900", X_TEST_LOGIN);

    expect(seen.length).toBe(12);
    const nonces = new Set<string>();
    for (const s of seen) {
      expect(HEADER.test(s.auth)).toBe(true);
      expect(field(s.auth, "oauth_consumer_key") === X_TEST_BUNDLE.apiKey).toBe(true);
      expect(field(s.auth, "oauth_token") === X_TEST_BUNDLE.accessToken).toBe(true);
      expect(s.auth.includes(X_TEST_BUNDLE.apiSecret) || s.auth.includes(X_TEST_BUNDLE.accessTokenSecret)).toBe(false); // the two secrets are never sent, only used to sign
      expect(/^Bearer/i.test(s.auth)).toBe(false);
      nonces.add(field(s.auth, "oauth_nonce"));
    }
    expect(nonces.size).toBe(seen.length); // a fresh nonce per request
  });
});
