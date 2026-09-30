// Instagram Stories + trial reels and Facebook Page Stories. fetch is stubbed and
// setTimeout runs immediately (recording delays). Nothing real is called.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InstagramAdapter } from "./instagram.js";
import { FacebookAdapter } from "./facebook.js";

type Call = { url: string; method: string; body: URLSearchParams | null; headers: Record<string, string> };
let calls: Call[];
let delays: number[];
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

function stubFetch(handler: (c: Call) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const c: Call = { url, method: init?.method ?? "GET", body: init?.body ? new URLSearchParams(init.body) : null, headers: init?.headers ?? {} };
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

const req = (over: Record<string, unknown> = {}) =>
  ({ socialAccountId: "sa1", content: "Caption", mediaUrl: "https://cdn.example.com/1.jpg", coverImageUrl: null, accessToken: "tok", ...over }) as never;

describe("Instagram Stories and trial reels", () => {
  const ig = () => new InstagramAdapter("c", "s", "https://x.example/cb");
  const igHandler = (c: Call) => {
    if (c.url.includes("/me?")) return json(200, { instagram_business_account: { id: "ig1" } });
    if (c.url.includes("fields=status_code")) return json(200, { status_code: "FINISHED" });
    if (c.url.endsWith("/ig1/media")) return json(200, { id: "cont1" });
    if (c.url.endsWith("/ig1/media_publish")) return json(200, { id: "post9" });
    return json(404, {});
  };
  const posts = () => calls.filter((c) => c.method === "POST");

  it("image story: STORIES container with image_url and no caption, image wait window, then publish", async () => {
    stubFetch(igHandler);
    const r = await ig().post(req({ options: { instagram: { placement: "story" } } }));
    expect(r).toEqual({ success: true, platformPostId: "post9", errorMessage: null });
    expect(calls.map((c) => c.url.replace("https://graph.facebook.com/v25.0", "").split("?")[0])).toEqual(["/me", "/ig1/media", "/cont1", "/ig1/media_publish"]);
    const create = posts()[0].body!;
    expect(create.get("media_type")).toBe("STORIES");
    expect(create.get("image_url")).toBe("https://cdn.example.com/1.jpg");
    expect(create.has("caption")).toBe(false);
    expect(create.has("video_url")).toBe(false);
    expect(posts()[1].body!.get("creation_id")).toBe("cont1");
  });

  it("video story: STORIES container with video_url, waits with the video window", async () => {
    let polls = 0;
    stubFetch((c) => {
      if (c.url.includes("fields=status_code")) return json(200, { status_code: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" });
      return igHandler(c);
    });
    const r = await ig().post(req({ mediaUrl: "https://cdn.example.com/1.mp4", options: { instagram: { placement: "story" } } }));
    expect(r.success).toBe(true);
    const create = posts()[0].body!;
    expect(create.get("media_type")).toBe("STORIES");
    expect(create.get("video_url")).toBe("https://cdn.example.com/1.mp4");
    expect(create.has("caption")).toBe(false);
    expect(delays).toEqual([60_000, 60_000]);
  });

  it("a refused story container returns the platform's message and never publishes", async () => {
    stubFetch((c) => (c.url.endsWith("/ig1/media") ? json(400, { error: { message: "Story image aspect ratio is not supported" } }) : igHandler(c)));
    const r = await ig().post(req({ options: { instagram: { placement: "story" } } }));
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Story image aspect ratio is not supported" });
    expect(calls.some((c) => c.url.endsWith("/media_publish"))).toBe(false);
  });

  it("a story container that errors during processing does not publish", async () => {
    stubFetch((c) => (c.url.includes("fields=status_code") ? json(200, { status_code: "ERROR" }) : igHandler(c)));
    const r = await ig().post(req({ options: { instagram: { placement: "story" } } }));
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("ERROR");
    expect(calls.some((c) => c.url.endsWith("/media_publish"))).toBe(false);
  });

  it("trial reel (manual): REELS container with trial_params MANUAL", async () => {
    stubFetch(igHandler);
    const r = await ig().post(req({ mediaUrl: "https://cdn.example.com/1.mp4", options: { instagram: { trialReel: true, trialGraduation: "manual" } } }));
    expect(r.success).toBe(true);
    const create = posts()[0].body!;
    expect(create.get("media_type")).toBe("REELS");
    expect(create.get("caption")).toBe("Caption");
    expect(JSON.parse(create.get("trial_params")!)).toEqual({ graduation_strategy: "MANUAL" });
  });

  it("trial reel (auto): graduation strategy SS_PERFORMANCE; unset graduation defaults to MANUAL", async () => {
    stubFetch(igHandler);
    await ig().post(req({ mediaUrl: "https://cdn.example.com/1.mp4", options: { instagram: { trialReel: true, trialGraduation: "auto" } } }));
    expect(JSON.parse(posts()[0].body!.get("trial_params")!)).toEqual({ graduation_strategy: "SS_PERFORMANCE" });
    calls = [];
    await ig().post(req({ mediaUrl: "https://cdn.example.com/1.mp4", options: { instagram: { trialReel: true } } }));
    expect(JSON.parse(posts()[0].body!.get("trial_params")!)).toEqual({ graduation_strategy: "MANUAL" });
  });

  it("a refused trial reel returns the platform's message and never publishes", async () => {
    stubFetch((c) => (c.url.endsWith("/ig1/media") ? json(400, { error: { message: "Trial reels are not available for this account" } }) : igHandler(c)));
    const r = await ig().post(req({ mediaUrl: "https://cdn.example.com/1.mp4", options: { instagram: { trialReel: true } } }));
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Trial reels are not available for this account" });
    expect(calls.some((c) => c.url.endsWith("/media_publish"))).toBe(false);
  });

  it("no options: image feed post and video Reel are unchanged (caption sent, no trial_params)", async () => {
    stubFetch(igHandler);
    await ig().post(req());
    let create = posts()[0].body!;
    expect(Object.fromEntries(create.entries())).toEqual({ caption: "Caption", access_token: "tok", image_url: "https://cdn.example.com/1.jpg" });
    calls = [];
    await ig().post(req({ mediaUrl: "https://cdn.example.com/1.mp4", options: {} }));
    create = posts()[0].body!;
    expect(Object.fromEntries(create.entries())).toEqual({ caption: "Caption", access_token: "tok", media_type: "REELS", video_url: "https://cdn.example.com/1.mp4" });
    expect(create.has("trial_params")).toBe(false);
  });
});

describe("Facebook Page Stories", () => {
  const fb = () => new FacebookAdapter("c", "s", "https://x.example/cb");
  const fbHandler = (c: Call) => {
    if (c.url.includes("/me?")) return json(200, { id: "page1" });
    if (c.url.endsWith("/page1/photos")) return json(200, { id: "ph1", post_id: "page1_ph1" });
    if (c.url.endsWith("/page1/photo_stories")) return json(200, { success: true, post_id: 1234 });
    if (c.url.endsWith("/page1/video_stories")) {
      return c.body?.get("upload_phase") === "start"
        ? json(200, { video_id: "vid1", upload_url: "https://rupload.facebook.com/video-upload/v25.0/vid1" })
        : json(200, { success: true, post_id: "5678" });
    }
    if (c.url.startsWith("https://rupload.facebook.com/")) return json(200, { success: true });
    return json(404, {});
  };
  const path = (c: Call) => c.url.replace("https://graph.facebook.com/v25.0", "").split("?")[0];

  it("photo story: unpublished photo upload, then photo_stories with the photo id; returns post_id", async () => {
    stubFetch(fbHandler);
    const r = await fb().post(req({ options: { facebook: { placement: "story" } } }));
    expect(r).toEqual({ success: true, platformPostId: "1234", errorMessage: null });
    expect(calls.map(path)).toEqual(["/me", "/page1/photos", "/page1/photo_stories"]);
    expect(calls[1].body!.get("published")).toBe("false");
    expect(calls[1].body!.get("url")).toBe("https://cdn.example.com/1.jpg");
    expect(calls[1].body!.has("caption")).toBe(false);
    expect(calls[2].body!.get("photo_id")).toBe("ph1");
  });

  it("video story: start, hosted upload via file_url header, finish with the video id; returns post_id", async () => {
    stubFetch(fbHandler);
    const r = await fb().post(req({ mediaUrl: "https://cdn.example.com/1.mp4", options: { facebook: { placement: "story" } } }));
    expect(r).toEqual({ success: true, platformPostId: "5678", errorMessage: null });
    expect(calls.map((c) => (c.url.startsWith("https://rupload") ? c.url : path(c)))).toEqual([
      "/me",
      "/page1/video_stories",
      "https://rupload.facebook.com/video-upload/v25.0/vid1",
      "/page1/video_stories",
    ]);
    expect(calls[1].body!.get("upload_phase")).toBe("start");
    expect(calls[2].method).toBe("POST");
    expect(calls[2].headers.file_url).toBe("https://cdn.example.com/1.mp4");
    expect(calls[2].headers.Authorization).toBe("OAuth tok");
    expect(calls[3].body!.get("upload_phase")).toBe("finish");
    expect(calls[3].body!.get("video_id")).toBe("vid1");
  });

  it("a refused photo upload returns the platform's message and never creates the story", async () => {
    stubFetch((c) => (c.url.endsWith("/page1/photos") ? json(400, { error: { message: "Photo could not be fetched" } }) : fbHandler(c)));
    const r = await fb().post(req({ options: { facebook: { placement: "story" } } }));
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Photo could not be fetched" });
    expect(calls.some((c) => c.url.endsWith("/photo_stories"))).toBe(false);
  });

  it("a refused video upload returns the platform's message and never finishes the story", async () => {
    stubFetch((c) => (c.url.startsWith("https://rupload") ? json(400, { error: { message: "Video too short" } }) : fbHandler(c)));
    const r = await fb().post(req({ mediaUrl: "https://cdn.example.com/1.mp4", options: { facebook: { placement: "story" } } }));
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Video too short" });
    expect(calls.filter((c) => c.body?.get("upload_phase") === "finish")).toHaveLength(0);
  });

  it("a refused video start returns the platform's message and uploads nothing", async () => {
    stubFetch((c) => (c.body?.get("upload_phase") === "start" ? json(400, { error: { message: "No permission to post stories" } }) : fbHandler(c)));
    const r = await fb().post(req({ mediaUrl: "https://cdn.example.com/1.mp4", options: { facebook: { placement: "story" } } }));
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "No permission to post stories" });
    expect(calls.some((c) => c.url.startsWith("https://rupload"))).toBe(false);
  });

  it("no options / feed placement: photo, video and text posts are unchanged", async () => {
    stubFetch(fbHandler);
    await fb().post(req());
    expect(calls.map(path)).toEqual(["/me", "/page1/photos"]);
    expect(calls[1].body!.get("caption")).toBe("Caption");
    expect(calls[1].body!.has("published")).toBe(false);
    calls = [];
    await fb().post(req({ mediaUrl: "https://cdn.example.com/1.mp4", options: { facebook: { placement: "feed" } } }));
    expect(calls.map(path)).toEqual(["/me", "/page1/videos"]);
    calls = [];
    await fb().post(req({ mediaUrl: null }));
    expect(calls.map(path)).toEqual(["/me", "/page1/feed"]);
  });

  it("verifyPublished confirms a story through the Page's /stories list when the node read fails", async () => {
    stubFetch((c) => {
      if (c.url.includes("/me/stories")) return json(200, { data: [{ post_id: "9", status: "PUBLISHED", url: "https://facebook.com/stories/1" }, { post_id: 1234, status: "PUBLISHED", url: "https://facebook.com/stories/2" }] });
      return json(400, { error: { message: "Object does not exist" } });
    });
    const v = await fb().verifyPublished("1234", "tok");
    expect(v).toEqual({ verifiedLive: true, platformPostUrl: "https://facebook.com/stories/2", errorMessage: null });
  });

  it("verifyPublished still fails when the story is not in the list", async () => {
    stubFetch((c) => (c.url.includes("/me/stories") ? json(200, { data: [] }) : json(400, { error: { message: "Object does not exist" } })));
    const v = await fb().verifyPublished("1234", "tok");
    expect(v.verifiedLive).toBe(false);
    expect(v.errorMessage).toBe("Object does not exist");
  });
});
