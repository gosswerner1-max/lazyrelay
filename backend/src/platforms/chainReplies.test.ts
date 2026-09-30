// Thread-chain follow-ups (postChainReply) for Threads, Bluesky, Mastodon and X.
// fetch is stubbed; nothing real is called.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../supabase.js", () => ({ supabase: {} }));
vi.mock("./streamUpload.js", () => ({ fetchMediaForStreaming: vi.fn(), buildStreamingMultipartBody: vi.fn() }));

import { runChain } from "../chainRunner.js";
import { ThreadsAdapter } from "./threads.js";
import { BlueskyAdapter } from "./bluesky.js";
import { MastodonAdapter } from "./mastodon.js";
import { XAdapter } from "./x.js";

type Call = { url: string; method: string; headers: Record<string, string>; raw: string | null };
let calls: Call[];
let handler: (url: string, init: Call) => { status: number; body: unknown };

const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const call: Call = { url, method: init?.method ?? "GET", headers: init?.headers ?? {}, raw: init?.body ?? null };
      calls.push(call);
      const r = handler(url, call);
      return res(r.status, r.body);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("Threads", () => {
  const adapter = () => new ThreadsAdapter("id", "secret", "https://api.example.org/cb");
  let n: number;
  beforeEach(() => {
    n = 0;
    handler = (url) => {
      if (url.includes("fields=status")) return { status: 200, body: { status: "FINISHED" } };
      if (url.endsWith("/u1/threads")) return { status: 200, body: { id: `c${++n}` } };
      if (url.endsWith("/u1/threads_publish")) return { status: 200, body: { id: `p${n}` } };
      return { status: 404, body: {} };
    };
  });

  it("sends a TEXT container with reply_to_id then publishes it", async () => {
    const r = await adapter().postChainReply({ rootPostId: "root", parentPostId: "root", text: "hi", accessToken: "tok", platformAccountId: "u1" });
    expect(r).toEqual({ success: true, platformPostId: "p1", errorMessage: null });
    const create = calls.find((c) => c.url === "https://graph.threads.net/v1.0/u1/threads")!;
    expect(create.method).toBe("POST");
    const body = new URLSearchParams(create.raw!);
    expect(Object.fromEntries(body)).toEqual({ media_type: "TEXT", text: "hi", reply_to_id: "root", access_token: "tok" });
    const pub = calls.find((c) => c.url.endsWith("/u1/threads_publish"))!;
    expect(Object.fromEntries(new URLSearchParams(pub.raw!))).toEqual({ creation_id: "c1", access_token: "tok" });
  });

  it("falls back to /me for the user id when none is given", async () => {
    const base = handler;
    handler = (url, c) => (url.includes("/me?") ? { status: 200, body: { id: "u1", username: "x" } } : base(url, c));
    const r = await adapter().postChainReply({ rootPostId: "root", parentPostId: "root", text: "hi", accessToken: "tok" });
    expect(r.success).toBe(true);
  });

  it("threads a 3-item chain through runChain, each replying to the previous", async () => {
    const out = await runChain(adapter(), { rootPostId: "main", texts: ["a", "b", "c"], accessToken: "tok", platformAccountId: "u1" });
    expect(out).toEqual({ posted: 3, error: null });
    const replyTos = calls.filter((c) => c.url.endsWith("/u1/threads")).map((c) => new URLSearchParams(c.raw!).get("reply_to_id"));
    expect(replyTos).toEqual(["main", "p1", "p2"]);
  });

  it("returns the platform's message on refusal", async () => {
    handler = () => ({ status: 400, body: { error: { message: "Reply not allowed" } } });
    const r = await adapter().postChainReply({ rootPostId: "r", parentPostId: "r", text: "x", accessToken: "t", platformAccountId: "u1" });
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Reply not allowed" });
  });
});

describe("Bluesky", () => {
  const adapter = () => new BlueskyAdapter("https://app.example.org/connect");
  const uri = (k: string) => `at://did:plc:me/app.bsky.feed.post/${k}`;
  let n: number;
  beforeEach(() => {
    n = 0;
    handler = (url) => {
      if (url.includes("com.atproto.repo.getRecord")) {
        const rkey = new URL(url).searchParams.get("rkey")!;
        return { status: 200, body: { uri: uri(rkey), cid: `cid-${rkey}`, value: {} } };
      }
      if (url.endsWith("com.atproto.server.getSession")) return { status: 200, body: { did: "did:plc:me" } };
      if (url.endsWith("com.atproto.repo.createRecord")) return { status: 200, body: { uri: uri(`r${++n}`), cid: `cid-r${n}` } };
      return { status: 404, body: {} };
    };
  });

  it("builds a reply record with root and parent {uri,cid}", async () => {
    const r = await adapter().postChainReply({ rootPostId: uri("main"), parentPostId: uri("prev"), text: "hello", accessToken: "tok" });
    expect(r).toEqual({ success: true, platformPostId: uri("r1"), errorMessage: null });
    const create = calls.find((c) => c.url.endsWith("createRecord"))!;
    expect(create.headers.Authorization).toBe("Bearer tok");
    const body = JSON.parse(create.raw!);
    expect(body.repo).toBe("did:plc:me");
    expect(body.collection).toBe("app.bsky.feed.post");
    expect(body.record.text).toBe("hello");
    expect(body.record.reply).toEqual({
      root: { uri: uri("main"), cid: "cid-main" },
      parent: { uri: uri("prev"), cid: "cid-prev" },
    });
  });

  it("makes links and hashtags clickable in the main post and in a follow-up (facets)", async () => {
    const text = "New: https://lazyrelay.com/changelog #launch";
    await adapter().post({ socialAccountId: "sa1", content: text, mediaUrl: null, coverImageUrl: null, accessToken: "tok" } as never);
    await adapter().postChainReply({ rootPostId: uri("main"), parentPostId: uri("prev"), text, accessToken: "tok" });
    const records = calls.filter((c) => c.url.endsWith("createRecord")).map((c) => JSON.parse(c.raw!).record);
    expect(records).toHaveLength(2);
    for (const rec of records) {
      const kinds = rec.facets.map((f: { features: Array<{ $type: string }> }) => f.features[0].$type);
      expect(kinds).toEqual(["app.bsky.richtext.facet#link", "app.bsky.richtext.facet#tag"]);
      expect(rec.facets[0].features[0].uri).toBe("https://lazyrelay.com/changelog");
    }
  });

  it("sends no facets field when the text has no link or hashtag", async () => {
    await adapter().postChainReply({ rootPostId: uri("main"), parentPostId: uri("prev"), text: "plain words", accessToken: "tok" });
    const rec = JSON.parse(calls.find((c) => c.url.endsWith("createRecord"))!.raw!).record;
    expect(rec.facets).toBeUndefined();
  });

  it("threads a 3-item chain: root stays the main post, parent moves to the previous reply uri", async () => {
    const out = await runChain(adapter(), { rootPostId: uri("main"), texts: ["a", "b", "c"], accessToken: "tok", platformAccountId: "did:plc:me" });
    expect(out).toEqual({ posted: 3, error: null });
    const replies = calls.filter((c) => c.url.endsWith("createRecord")).map((c) => JSON.parse(c.raw!).record.reply);
    expect(replies.map((x) => x.root.uri)).toEqual([uri("main"), uri("main"), uri("main")]);
    expect(replies.map((x) => x.parent.uri)).toEqual([uri("main"), uri("r1"), uri("r2")]);
    expect(replies[2].parent.cid).toBe("cid-r2");
    // did came from platformAccountId, so no getSession call
    expect(calls.some((c) => c.url.endsWith("getSession"))).toBe(false);
  });

  it("returns the platform's message on refusal", async () => {
    const base = handler;
    handler = (url, c) => (url.endsWith("createRecord") ? { status: 400, body: { error: "InvalidRequest", message: "Record rejected" } } : base(url, c));
    const r = await adapter().postChainReply({ rootPostId: uri("m"), parentPostId: uri("m"), text: "x", accessToken: "t" });
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Record rejected" });
  });

  it("fails cleanly when the parent record cannot be looked up", async () => {
    handler = () => ({ status: 400, body: { message: "Could not locate record" } });
    const r = await adapter().postChainReply({ rootPostId: uri("m"), parentPostId: uri("m"), text: "x", accessToken: "t" });
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Could not locate record" });
  });
});

describe("Mastodon", () => {
  const adapter = () => new MastodonAdapter("https://api.example.org/cb");
  let n: number;
  beforeEach(() => {
    n = 0;
    handler = () => ({ status: 200, body: { id: `s${++n}` } });
  });

  it("posts a public status with in_reply_to_id", async () => {
    const r = await adapter().postChainReply({ rootPostId: "main", parentPostId: "main", text: "hey", accessToken: "tok" });
    expect(r).toEqual({ success: true, platformPostId: "s1", errorMessage: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://mastodon.social/api/v1/statuses");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[0].raw!)).toEqual({ status: "hey", in_reply_to_id: "main", visibility: "public" });
  });

  it("threads a 3-item chain through runChain", async () => {
    const out = await runChain(adapter(), { rootPostId: "main", texts: ["a", "b", "c"], accessToken: "tok" });
    expect(out).toEqual({ posted: 3, error: null });
    expect(calls.map((c) => JSON.parse(c.raw!).in_reply_to_id)).toEqual(["main", "s1", "s2"]);
  });

  it("returns the platform's message on refusal", async () => {
    handler = () => ({ status: 422, body: { error: "Validation failed: Text too long" } });
    const r = await adapter().postChainReply({ rootPostId: "m", parentPostId: "m", text: "x", accessToken: "t" });
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Validation failed: Text too long" });
  });
});

describe("X", () => {
  const adapter = () => new XAdapter("id", "secret", "https://api.example.org/cb");
  let n: number;
  beforeEach(() => {
    n = 0;
    handler = () => ({ status: 201, body: { data: { id: `t${++n}`, text: "x" } } });
  });

  it("posts /2/tweets with reply.in_reply_to_tweet_id", async () => {
    const r = await adapter().postChainReply({ rootPostId: "main", parentPostId: "main", text: "yo", accessToken: "tok" });
    expect(r).toEqual({ success: true, platformPostId: "t1", errorMessage: null });
    expect(calls[0].url).toBe("https://api.twitter.com/2/tweets");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[0].raw!)).toEqual({ text: "yo", reply: { in_reply_to_tweet_id: "main" } });
  });

  it("threads a 3-item chain through runChain", async () => {
    const out = await runChain(adapter(), { rootPostId: "main", texts: ["a", "b", "c"], accessToken: "tok" });
    expect(out).toEqual({ posted: 3, error: null });
    expect(calls.map((c) => JSON.parse(c.raw!).reply.in_reply_to_tweet_id)).toEqual(["main", "t1", "t2"]);
  });

  it("returns the platform's message on refusal (errors array and problem detail)", async () => {
    handler = () => ({ status: 403, body: { errors: [{ message: "You are not allowed to reply" }] } });
    let r = await adapter().postChainReply({ rootPostId: "m", parentPostId: "m", text: "x", accessToken: "t" });
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "You are not allowed to reply" });
    handler = () => ({ status: 403, body: { title: "Forbidden", detail: "Reply restricted" } });
    r = await adapter().postChainReply({ rootPostId: "m", parentPostId: "m", text: "x", accessToken: "t" });
    expect(r.errorMessage).toBe("Reply restricted");
  });
});
