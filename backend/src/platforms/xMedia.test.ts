// The two X media upload flows behind the single selector: every step signed, segments split, processing polled,
// and a refusal names the exact step. fetch is injected; nothing real is called.

import { describe, it, expect } from "vitest";
import { createXMediaUploader, MEDIA_SEGMENT_BYTES, X_MEDIA_FLOW, mediaCategoryFor } from "./xMedia.js";
import { X_TEST_BUNDLE } from "./xTestKit.js";

type Call = { url: string; method: string; auth: string; body: unknown };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function harness(route: (c: Call, n: number) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const c: Call = { url, method: init.method ?? "GET", auth: (init.headers as Record<string, string>).Authorization, body: init.body };
    calls.push(c);
    return route(c, calls.length);
  }) as never;
  return { calls, fetchImpl };
}
const png = { bytes: Buffer.from("png-bytes"), mimeType: "image/png" };

describe("the selector", () => {
  it("defaults to the v2 flow until the live probe says otherwise", () => {
    expect(X_MEDIA_FLOW).toBe("v2");
  });
  it("picks the upload category from the type", () => {
    expect([mediaCategoryFor("image/jpeg"), mediaCategoryFor("image/gif"), mediaCategoryFor("video/mp4")]).toEqual(["tweet_image", "tweet_gif", "tweet_video"]);
  });
});

describe("v2 flow", () => {
  it("initialize, append, finalize, all signed, JSON init body", async () => {
    const h = harness((c) => (c.url.endsWith("/initialize") ? reply(200, { data: { id: "m1", media_key: "k" } }) : reply(200, { data: {} })));
    const r = await createXMediaUploader("v2", X_TEST_BUNDLE, { fetchImpl: h.fetchImpl }).upload(png);
    expect(r).toMatchObject({ ok: true, mediaId: "m1" });
    expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.x.com/2/media/upload/initialize",
      "POST https://api.x.com/2/media/upload/m1/append",
      "POST https://api.x.com/2/media/upload/m1/finalize",
    ]);
    for (const c of h.calls) expect(c.auth).toMatch(/^OAuth .*oauth_signature=/);
    expect(JSON.parse(h.calls[0].body as string)).toEqual({ media_type: "image/png", total_bytes: 9, media_category: "tweet_image" });
    expect(h.calls[1].body).toBeInstanceOf(FormData);
    expect(r.steps.map((s) => s.step)).toEqual(["initialize", "append", "finalize"]);
  });

  it("splits a big file into segments of at most MEDIA_SEGMENT_BYTES", async () => {
    const h = harness((c) => (c.url.endsWith("/initialize") ? reply(200, { data: { id: "m2" } }) : reply(200, { data: {} })));
    const big = { bytes: Buffer.alloc(MEDIA_SEGMENT_BYTES * 2 + 10), mimeType: "image/jpeg" };
    await createXMediaUploader("v2", X_TEST_BUNDLE, { fetchImpl: h.fetchImpl }).upload(big);
    const appends = h.calls.filter((c) => c.url.endsWith("/append"));
    expect(appends).toHaveLength(3);
    expect((appends[2].body as FormData).get("segment_index")).toBe("2");
  });

  it("polls STATUS until processing succeeds", async () => {
    let polls = 0;
    const h = harness((c) => {
      if (c.url.endsWith("/initialize")) return reply(200, { data: { id: "m3" } });
      if (c.url.endsWith("/finalize")) return reply(200, { data: { processing_info: { state: "pending", check_after_secs: 1 } } });
      if (c.url.includes("command=STATUS")) return reply(200, { data: { processing_info: { state: ++polls < 2 ? "in_progress" : "succeeded" } } });
      return reply(200, { data: {} });
    });
    const r = await createXMediaUploader("v2", X_TEST_BUNDLE, { fetchImpl: h.fetchImpl, sleep: async () => {} }).upload({ bytes: Buffer.from("v"), mimeType: "video/mp4" });
    expect(r).toMatchObject({ ok: true, mediaId: "m3" });
    const status = h.calls.filter((c) => c.url.includes("command=STATUS"));
    expect(status).toHaveLength(2);
    expect(status[0].url).toBe("https://api.x.com/2/media/upload?command=STATUS&media_id=m3");
    expect(status[0].method).toBe("GET");
  });

  it("reports exactly which step X refused, with X's own error fields", async () => {
    const h = harness((c) => (c.url.endsWith("/initialize") ? reply(403, { title: "Forbidden", type: "https://api.x.com/2/problems/oauth1-permissions", detail: "no" }) : reply(200, {})));
    const r = await createXMediaUploader("v2", X_TEST_BUNDLE, { fetchImpl: h.fetchImpl }).upload(png);
    expect(r).toMatchObject({ ok: false, failedStep: "initialize" });
    if (r.ok) throw new Error("unreachable");
    expect(r.steps[0]).toEqual({ step: "initialize", ok: false, status: 403, error: { title: "Forbidden", type: "https://api.x.com/2/problems/oauth1-permissions", detail: "no" } });
    expect(r.errorMessage).toContain("media initialize: x_api_error status=403");
    expect(h.calls).toHaveLength(1);
  });

  it("a failed processing state fails at the status step", async () => {
    const h = harness((c) => {
      if (c.url.endsWith("/initialize")) return reply(200, { data: { id: "m4" } });
      if (c.url.endsWith("/finalize")) return reply(200, { data: { processing_info: { state: "failed" } } });
      return reply(200, { data: {} });
    });
    const r = await createXMediaUploader("v2", X_TEST_BUNDLE, { fetchImpl: h.fetchImpl, sleep: async () => {} }).upload(png);
    expect(r).toMatchObject({ ok: false, failedStep: "status" });
  });
});

describe("v1.1 fallback flow", () => {
  it("INIT, APPEND, FINALIZE on upload.twitter.com, signed, with the command in the query or multipart body", async () => {
    const h = harness((c) => (c.url.includes("command=INIT") ? reply(200, { media_id_string: "9001" }) : new Response(null, { status: 204 })));
    const r = await createXMediaUploader("v1", X_TEST_BUNDLE, { fetchImpl: h.fetchImpl }).upload(png);
    expect(r).toMatchObject({ ok: true, mediaId: "9001" });
    expect(h.calls[0].url).toBe("https://upload.twitter.com/1.1/media/upload.json?command=INIT&total_bytes=9&media_type=image%2Fpng&media_category=tweet_image");
    expect(h.calls[1].url).toBe("https://upload.twitter.com/1.1/media/upload.json");
    const form = h.calls[1].body as FormData;
    expect([form.get("command"), form.get("media_id"), form.get("segment_index")]).toEqual(["APPEND", "9001", "0"]);
    expect(h.calls[2].url).toBe("https://upload.twitter.com/1.1/media/upload.json?command=FINALIZE&media_id=9001");
    for (const c of h.calls) expect(c.auth).toMatch(/^OAuth /);
  });

  it("reports a v1.1 refusal at its step", async () => {
    const h = harness((c) => (c.url.includes("command=INIT") ? reply(200, { media_id_string: "1" }) : reply(401, { errors: [{ code: 89, message: "Invalid or expired token." }] })));
    const r = await createXMediaUploader("v1", X_TEST_BUNDLE, { fetchImpl: h.fetchImpl }).upload(png);
    expect(r).toMatchObject({ ok: false, failedStep: "append" });
    if (r.ok) throw new Error("unreachable");
    expect(r.steps[r.steps.length - 1]).toMatchObject({ status: 401, error: { title: "code 89", detail: "Invalid or expired token." } });
  });
});
