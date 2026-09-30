// Multi-media posting in the Meta adapters (Instagram carousel with videos,
// Threads carousel, Facebook multi-photo). fetch is stubbed and setTimeout is
// replaced by an immediate-run stub that records requested delays, so the
// 30s/60s waits neither slow nor flake the tests. Nothing real is called.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InstagramAdapter } from "./instagram.js";
import { ThreadsAdapter } from "./threads.js";
import { FacebookAdapter } from "./facebook.js";

type Call = { url: string; method: string; body: URLSearchParams | null };
let calls: Call[];
let delays: number[];
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

function stubFetch(handler: (c: Call) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const c: Call = { url, method: init?.method ?? "GET", body: init?.body ? new URLSearchParams(init.body) : null };
      calls.push(c);
      return handler(c);
    }),
  );
}

beforeEach(() => {
  calls = [];
  delays = [];
  vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
});
afterEach(() => vi.unstubAllGlobals());

const req = (over: Record<string, unknown> = {}) => ({
  socialAccountId: "sa1",
  content: "Caption",
  mediaUrl: "https://cdn.example.com/1.jpg",
  mediaUrls: ["https://cdn.example.com/2.mp4", "https://cdn.example.com/3.png"],
  coverImageUrl: null,
  accessToken: "tok",
  ...over,
}) as never;

describe("Instagram carousel with mixed media", () => {
  const ig = () => new InstagramAdapter("c", "s", "https://x.example/cb");
  const igHandler = (c: Call, counter: { n: number }) => {
    if (c.url.includes("/me?")) return json(200, { instagram_business_account: { id: "ig1" } });
    if (c.url.includes("fields=status_code")) return json(200, { status_code: "FINISHED" });
    if (c.url.endsWith("/ig1/media")) return json(200, { id: `c${++counter.n}` });
    if (c.url.endsWith("/ig1/media_publish")) return json(200, { id: "post9" });
    return json(404, {});
  };

  it("sends VIDEO children with media_type+video_url, images with image_url, then parent in order, then publishes", async () => {
    const counter = { n: 0 };
    stubFetch((c) => igHandler(c, counter));
    const r = await ig().post(req());
    expect(r).toEqual({ success: true, platformPostId: "post9", errorMessage: null });
    const creates = calls.filter((c) => c.url.endsWith("/ig1/media"));
    expect(creates).toHaveLength(4);
    expect(creates[0].body!.get("image_url")).toBe("https://cdn.example.com/1.jpg");
    expect(creates[0].body!.get("media_type")).toBeNull();
    expect(creates[1].body!.get("media_type")).toBe("VIDEO");
    expect(creates[1].body!.get("video_url")).toBe("https://cdn.example.com/2.mp4");
    expect(creates[1].body!.get("image_url")).toBeNull();
    expect(creates[2].body!.get("image_url")).toBe("https://cdn.example.com/3.png");
    expect(creates.slice(0, 3).every((c) => c.body!.get("is_carousel_item") === "true")).toBe(true);
    expect(creates[3].body!.get("media_type")).toBe("CAROUSEL");
    expect(creates[3].body!.get("children")).toBe("c1,c2,c3");
    expect(creates[3].body!.get("caption")).toBe("Caption");
    expect(calls.find((c) => c.url.endsWith("/media_publish"))!.body!.get("creation_id")).toBe("c4");
  });

  it("uses the video polling window (60s) for the video child and the 3s image window for images", async () => {
    const counter = { n: 0 };
    let statusHits = 0;
    stubFetch((c) => {
      if (c.url.includes("fields=status_code")) {
        // c2 (the video) is IN_PROGRESS once, then FINISHED
        if (c.url.includes("/c2?") && statusHits++ === 0) return json(200, { status_code: "IN_PROGRESS" });
        return json(200, { status_code: "FINISHED" });
      }
      return igHandler(c, counter);
    });
    const r = await ig().post(req());
    expect(r.success).toBe(true);
    expect(delays).toEqual([60_000]);
  });

  it("stops with the platform's own message when a middle item is refused, without publishing", async () => {
    let n = 0;
    stubFetch((c) => {
      if (c.url.includes("/me?")) return json(200, { instagram_business_account: { id: "ig1" } });
      if (c.url.includes("fields=status_code")) return json(200, { status_code: "FINISHED" });
      if (c.url.endsWith("/ig1/media")) return ++n === 2 ? json(400, { error: { message: "Video file is not supported." } }) : json(200, { id: `c${n}` });
      return json(404, {});
    });
    const r = await ig().post(req());
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Video file is not supported." });
    expect(calls.some((c) => c.url.endsWith("/media_publish"))).toBe(false);
    expect(calls.filter((c) => c.url.endsWith("/ig1/media"))).toHaveLength(2);
  });

  it("a single video is still a REELS post (unchanged)", async () => {
    const counter = { n: 0 };
    stubFetch((c) => igHandler(c, counter));
    await ig().post(req({ mediaUrl: "https://cdn.example.com/v.mp4", mediaUrls: [] }));
    const creates = calls.filter((c) => c.url.endsWith("/ig1/media"));
    expect(creates).toHaveLength(1);
    expect(creates[0].body!.get("media_type")).toBe("REELS");
    expect(creates[0].body!.get("is_carousel_item")).toBeNull();
  });
});

describe("Threads carousel", () => {
  const th = () => new ThreadsAdapter("c", "s", "https://x.example/cb");
  const thHandler = (c: Call, counter: { n: number }) => {
    if (c.url.includes("/me?")) return json(200, { id: "t1", username: "u" });
    if (c.method === "GET" && c.url.includes("fields=status")) return json(200, { status: "FINISHED" });
    if (c.url.endsWith("/t1/threads")) return json(200, { id: `k${++counter.n}` });
    if (c.url.endsWith("/t1/threads_publish")) return json(200, { id: "tp1" });
    return json(404, {});
  };

  it("creates items (IMAGE/VIDEO with is_carousel_item), then a CAROUSEL parent with ordered children and text, then publishes", async () => {
    const counter = { n: 0 };
    stubFetch((c) => thHandler(c, counter));
    const r = await th().post(req());
    expect(r).toEqual({ success: true, platformPostId: "tp1", errorMessage: null });
    const creates = calls.filter((c) => c.url.endsWith("/t1/threads"));
    expect(creates).toHaveLength(4);
    expect(creates[0].body!.get("media_type")).toBe("IMAGE");
    expect(creates[0].body!.get("image_url")).toBe("https://cdn.example.com/1.jpg");
    expect(creates[1].body!.get("media_type")).toBe("VIDEO");
    expect(creates[1].body!.get("video_url")).toBe("https://cdn.example.com/2.mp4");
    expect(creates[2].body!.get("image_url")).toBe("https://cdn.example.com/3.png");
    expect(creates.slice(0, 3).every((c) => c.body!.get("is_carousel_item") === "true" && c.body!.get("text") === null)).toBe(true);
    expect(creates[3].body!.get("media_type")).toBe("CAROUSEL");
    expect(creates[3].body!.get("children")).toBe("k1,k2,k3");
    expect(creates[3].body!.get("text")).toBe("Caption");
    expect(calls.find((c) => c.url.endsWith("/threads_publish"))!.body!.get("creation_id")).toBe("k4");
    // Only the video child waits the 30s; the parent is status-polled with no sleep.
    expect(delays).toEqual([30_000]);
  });

  it("an all-image carousel never sleeps", async () => {
    const counter = { n: 0 };
    stubFetch((c) => thHandler(c, counter));
    const r = await th().post(req({ mediaUrls: ["https://cdn.example.com/2.jpg"] }));
    expect(r.success).toBe(true);
    expect(delays).toEqual([]);
  });

  it("stops with the platform's message when an item is refused, without publishing", async () => {
    let n = 0;
    stubFetch((c) => {
      if (c.url.includes("/me?")) return json(200, { id: "t1" });
      if (c.method === "GET") return json(200, { status: "FINISHED" });
      if (c.url.endsWith("/t1/threads")) return ++n === 3 ? json(400, { error: { message: "Media could not be fetched." } }) : json(200, { id: `k${n}` });
      return json(404, {});
    });
    const r = await th().post(req());
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Media could not be fetched." });
    expect(calls.some((c) => c.url.endsWith("/threads_publish"))).toBe(false);
  });

  it("a failed video child stops the post without publishing", async () => {
    const counter = { n: 0 };
    stubFetch((c) => {
      if (c.method === "GET" && c.url.includes("fields=status")) return json(200, { status: "ERROR" });
      return thHandler(c, counter);
    });
    const r = await th().post(req());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("ERROR");
    expect(calls.some((c) => c.url.endsWith("/threads_publish"))).toBe(false);
  });

  it("a single image post is unchanged (one IMAGE container, no carousel params)", async () => {
    const counter = { n: 0 };
    stubFetch((c) => thHandler(c, counter));
    await th().post(req({ mediaUrls: [] }));
    const creates = calls.filter((c) => c.url.endsWith("/t1/threads"));
    expect(creates).toHaveLength(1);
    expect(creates[0].body!.get("media_type")).toBe("IMAGE");
    expect(creates[0].body!.get("text")).toBe("Caption");
    expect(creates[0].body!.get("is_carousel_item")).toBeNull();
  });
});

describe("Facebook multi-photo", () => {
  const fb = () => new FacebookAdapter("c", "s", "https://x.example/cb");
  const photos = ["https://cdn.example.com/1.jpg", "https://cdn.example.com/2.jpg", "https://cdn.example.com/3.png"];
  const fbHandler = (c: Call, counter: { n: number }) => {
    if (c.url.includes("/me?")) return json(200, { id: "pg1" });
    if (c.url.endsWith("/pg1/photos")) return json(200, { id: `ph${++counter.n}` });
    if (c.url.endsWith("/pg1/feed")) return json(200, { id: "pg1_777" });
    return json(404, {});
  };

  it("uploads each photo unpublished in order, then one feed post with attached_media in the same order", async () => {
    const counter = { n: 0 };
    stubFetch((c) => fbHandler(c, counter));
    const r = await fb().post(req({ mediaUrl: photos[0], mediaUrls: photos.slice(1) }));
    expect(r).toEqual({ success: true, platformPostId: "pg1_777", errorMessage: null });
    const uploads = calls.filter((c) => c.url.endsWith("/pg1/photos"));
    expect(uploads.map((c) => c.body!.get("url"))).toEqual(photos);
    expect(uploads.every((c) => c.body!.get("published") === "false")).toBe(true);
    const feeds = calls.filter((c) => c.url.endsWith("/pg1/feed"));
    expect(feeds).toHaveLength(1);
    expect(feeds[0].body!.get("message")).toBe("Caption");
    expect(feeds[0].body!.get("attached_media[0]")).toBe('{"media_fbid":"ph1"}');
    expect(feeds[0].body!.get("attached_media[1]")).toBe('{"media_fbid":"ph2"}');
    expect(feeds[0].body!.get("attached_media[2]")).toBe('{"media_fbid":"ph3"}');
    // uploads all precede the feed post
    expect(calls.findIndex((c) => c.url.endsWith("/pg1/feed"))).toBeGreaterThan(calls.map((c) => c.url).lastIndexOf(`https://graph.facebook.com/v25.0/pg1/photos`));
  });

  it("stops with the platform's message when an upload is refused, without posting to the feed", async () => {
    let n = 0;
    stubFetch((c) => {
      if (c.url.includes("/me?")) return json(200, { id: "pg1" });
      if (c.url.endsWith("/pg1/photos")) return ++n === 2 ? json(400, { error: { message: "Invalid image URL." } }) : json(200, { id: `ph${n}` });
      return json(404, {});
    });
    const r = await fb().post(req({ mediaUrl: photos[0], mediaUrls: photos.slice(1) }));
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Invalid image URL." });
    expect(calls.some((c) => c.url.endsWith("/pg1/feed"))).toBe(false);
  });

  it("reports a refused feed post with the platform's message", async () => {
    stubFetch((c) => (c.url.endsWith("/pg1/feed") ? json(400, { error: { message: "Permissions error" } }) : fbHandler(c, { n: 0 })));
    const r = await fb().post(req({ mediaUrl: photos[0], mediaUrls: photos.slice(1) }));
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Permissions error" });
  });

  it("the returned page-post id is verifiable by verifyPublished", async () => {
    stubFetch((c) => (c.url.includes("/pg1_777?") ? json(200, { id: "pg1_777", permalink_url: "https://facebook.com/pg1/posts/777" }) : json(404, {})));
    const v = await fb().verifyPublished("pg1_777", "tok");
    expect(v).toEqual({ verifiedLive: true, platformPostUrl: "https://facebook.com/pg1/posts/777", errorMessage: null });
  });

  it("a single photo post is unchanged (one /photos call with caption, no published=false)", async () => {
    stubFetch((c) => (c.url.includes("/me?") ? json(200, { id: "pg1" }) : c.url.endsWith("/pg1/photos") ? json(200, { id: "ph1", post_id: "pg1_1" }) : json(404, {})));
    const r = await fb().post(req({ mediaUrl: photos[0], mediaUrls: [] }));
    expect(r).toEqual({ success: true, platformPostId: "pg1_1", errorMessage: null });
    const uploads = calls.filter((c) => c.url.endsWith("/pg1/photos"));
    expect(uploads).toHaveLength(1);
    expect(uploads[0].body!.get("caption")).toBe("Caption");
    expect(uploads[0].body!.get("published")).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/pg1/feed"))).toBe(false);
  });
});
