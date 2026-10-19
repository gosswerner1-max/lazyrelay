// Publish and upload calls to Meta carry NO client timeout. Meta fetches the media from our URL during these calls and may accept the
// post even if our side gives up, and an abort after acceptance would make the scheduler retry and post twice (the scheduler already
// recovers stuck posts). Connect, token-exchange and read calls keep the 120 s timeout. fetch is stubbed: nothing real is called.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FacebookAdapter } from "./facebook.js";
import { InstagramAdapter } from "./instagram.js";

type Call = { url: string; method: string; signal: AbortSignal | null | undefined };
let calls: Call[];
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

function stubFetch(handler: (url: string) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", signal: init?.signal });
      return handler(url);
    }),
  );
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal("setTimeout", ((fn: () => void) => {
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
});
afterEach(() => vi.unstubAllGlobals());

const req = (over: Record<string, unknown> = {}) =>
  ({ socialAccountId: "sa1", content: "Caption", mediaUrl: null, coverImageUrl: null, accessToken: "tok", ...over }) as never;
const IMG = "https://cdn.example.com/1.jpg";
const VID = "https://cdn.example.com/1.mp4";

const fbHandler = (url: string) =>
  url.includes("/me?") ? json({ id: "pg1" })
  : url.endsWith("/video_stories") ? json({ video_id: "v1", upload_url: "https://rupload.example.com/up", post_id: "s1" })
  : url.startsWith("https://rupload.example.com") ? json({ success: true })
  : url.endsWith("/photo_stories") ? json({ post_id: "s2" })
  : json({ id: "obj1", post_id: "pg1_9" });

const igHandler = (url: string) =>
  url.includes("/me?") ? json({ instagram_business_account: { id: "ig1" } })
  : url.includes("fields=status_code") ? json({ status_code: "FINISHED" })
  : url.endsWith("/ig1/media") ? json({ id: "cont1" })
  : url.endsWith("/ig1/media_publish") ? json({ id: "post9" })
  : json({});

function expectNoTimeoutOnWrites(label: string) {
  const writes = calls.filter((c) => c.method === "POST");
  expect(writes.length, `${label}: expected at least one POST`).toBeGreaterThan(0);
  for (const c of writes) expect(c.signal, `${label}: publish/upload call ${c.url} must not carry a timeout`).toBeUndefined();
  const reads = calls.filter((c) => c.method === "GET");
  expect(reads.length, `${label}: expected at least one read`).toBeGreaterThan(0);
  for (const c of reads) expect(c.signal, `${label}: read call ${c.url} keeps the timeout`).toBeInstanceOf(AbortSignal);
}

describe("Facebook publish and upload calls have no client timeout", () => {
  const fb = () => new FacebookAdapter("c", "s", "https://x.example/cb");
  const cases: [string, Record<string, unknown>][] = [
    ["text post (/feed)", {}],
    ["photo post", { mediaUrl: IMG }],
    ["video post", { mediaUrl: VID }],
    ["multi-photo (photos + /feed)", { mediaUrl: IMG, mediaUrls: [IMG] }],
    ["photo story", { mediaUrl: IMG, options: { facebook: { placement: "story" } } }],
    ["video story (start, upload_url, finish)", { mediaUrl: VID, options: { facebook: { placement: "story" } } }],
  ];
  for (const [label, over] of cases) {
    it(label, async () => {
      stubFetch(fbHandler);
      const r = await fb().post(req(over));
      expect(r.success, JSON.stringify(r)).toBe(true);
      expectNoTimeoutOnWrites(label);
    });
  }
});

describe("Instagram publish and upload calls have no client timeout", () => {
  const ig = () => new InstagramAdapter("c", "s", "https://x.example/cb");
  const cases: [string, Record<string, unknown>][] = [
    ["image (container + media_publish)", { mediaUrl: IMG }],
    ["reel", { mediaUrl: VID }],
    ["carousel", { mediaUrl: IMG, mediaUrls: [IMG] }],
  ];
  for (const [label, over] of cases) {
    it(label, async () => {
      stubFetch(igHandler);
      const r = await ig().post(req(over));
      expect(r.success, JSON.stringify(r)).toBe(true);
      expectNoTimeoutOnWrites(label);
    });
  }
});

describe("connect and token-exchange calls keep the timeout", () => {
  for (const [name, make] of [
    ["facebook", () => new FacebookAdapter("c", "s", "https://x.example/cb")],
    ["instagram", () => new InstagramAdapter("c", "s", "https://x.example/cb")],
  ] as const) {
    it(name, async () => {
      stubFetch((url) =>
        url.includes("/oauth/access_token") ? json({ access_token: "t" })
        : url.includes("/me/accounts") ? json({ data: [{ id: "p1", name: "Page", access_token: "pt", instagram_business_account: { id: "ig1" } }] })
        : json({ username: "acme" }),
      );
      await make().listConnectOptions("code");
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const c of calls) expect(c.signal, c.url).toBeInstanceOf(AbortSignal);
    });
  }
});
