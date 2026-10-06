// Threads text, image and reply posts wait for the container to be ready before they publish.
// Regression for 2026-10-06: a burst of text posts failed with "The requested resource does not exist"
// because the text path published the instant the container was created. fetch is stubbed; nothing real is called.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../supabase.js", () => ({ supabase: {} }));

import { ThreadsAdapter } from "./threads.js";
import type { PostRequest } from "./types.js";

type Call = { url: string; method: string; raw: string | null };
let calls: Call[];
let statusAnswers: Array<{ status: number; body: unknown }>;
let publishAnswer: { status: number; body: unknown };

const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;
const lag = { status: 400, body: { error: { message: "The requested resource does not exist" } } };
const finished = { status: 200, body: { status: "FINISHED" } };

beforeEach(() => {
  calls = [];
  statusAnswers = [finished];
  publishAnswer = { status: 200, body: { id: "tp1" } };
  vi.stubGlobal("setTimeout", ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method ?? "GET", raw: init?.body ?? null });
      if (url.includes("/me?")) return res(200, { id: "t1", username: "u" });
      if (url.includes("fields=status")) {
        const a = statusAnswers.length > 1 ? statusAnswers.shift()! : statusAnswers[0];
        return res(a.status, a.body);
      }
      if (url.endsWith("/t1/threads")) return res(200, { id: "c1" });
      if (url.endsWith("/t1/threads_publish")) return res(publishAnswer.status, publishAnswer.body);
      return res(404, {});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const adapter = () => new ThreadsAdapter("id", "secret", "https://api.example.org/cb");
const req = (over: Partial<PostRequest> = {}): PostRequest => ({ content: "hello", accessToken: "tok", socialAccountId: "s1", ...over }) as PostRequest;
const idx = (suffix: string) => calls.findIndex((c) => c.url.includes(suffix));
const statusCalls = () => calls.filter((c) => c.url.includes("fields=status"));

describe("Threads text post waits for the container", () => {
  it("checks the container status and only then publishes", async () => {
    const r = await adapter().post(req());
    expect(r).toEqual({ success: true, platformPostId: "tp1", errorMessage: null });
    expect(statusCalls()).toHaveLength(1);
    expect(idx("fields=status")).toBeGreaterThan(idx("/t1/threads"));
    expect(idx("/t1/threads_publish")).toBeGreaterThan(idx("fields=status"));
  });

  it("keeps polling while the container is IN_PROGRESS, then publishes", async () => {
    statusAnswers = [{ status: 200, body: { status: "IN_PROGRESS" } }, { status: 200, body: { status: "IN_PROGRESS" } }, finished];
    const r = await adapter().post(req());
    expect(r.success).toBe(true);
    expect(statusCalls()).toHaveLength(3);
    expect(idx("/t1/threads_publish")).toBeGreaterThan(calls.map((c) => c.url).lastIndexOf(statusCalls()[2].url));
  });

  it("treats 'The requested resource does not exist' as not visible yet, and publishes once it is", async () => {
    statusAnswers = [lag, lag, finished];
    const r = await adapter().post(req());
    expect(r).toEqual({ success: true, platformPostId: "tp1", errorMessage: null });
    expect(statusCalls()).toHaveLength(3);
    expect(calls.filter((c) => c.url.endsWith("/threads_publish"))).toHaveLength(1);
  });

  it("if the container never becomes readable it still tries to publish (never worse than before)", async () => {
    statusAnswers = [lag];
    publishAnswer = { status: 400, body: { error: { message: "The requested resource does not exist" } } };
    const r = await adapter().post(req());
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "The requested resource does not exist" });
    expect(statusCalls()).toHaveLength(10);
    expect(calls.filter((c) => c.url.endsWith("/threads_publish"))).toHaveLength(1);
  });

  it("does not publish when Threads says the container failed", async () => {
    statusAnswers = [{ status: 200, body: { status: "ERROR" } }];
    const r = await adapter().post(req());
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Threads media container failed processing (ERROR)" });
    expect(calls.some((c) => c.url.endsWith("/threads_publish"))).toBe(false);
  });

  it("does not keep waiting on a real error such as a permission problem", async () => {
    statusAnswers = [{ status: 403, body: { error: { message: "Insufficient permissions" } } }];
    const r = await adapter().post(req());
    expect(r).toEqual({ success: false, platformPostId: null, errorMessage: "Insufficient permissions" });
    expect(statusCalls()).toHaveLength(1);
    expect(calls.some((c) => c.url.endsWith("/threads_publish"))).toBe(false);
  });

  it("image posts get the same wait", async () => {
    statusAnswers = [lag, finished];
    const r = await adapter().post(req({ mediaUrl: "https://cdn.example.com/a.jpg" }));
    expect(r.success).toBe(true);
    expect(statusCalls()).toHaveLength(2);
  });
});

describe("Threads reply chain waits the same way", () => {
  it("tolerates a not-visible-yet container before publishing a reply", async () => {
    statusAnswers = [lag, finished];
    const r = await adapter().postChainReply({ rootPostId: "root", parentPostId: "root", text: "hi", accessToken: "tok", platformAccountId: "t1" });
    expect(r).toEqual({ success: true, platformPostId: "tp1", errorMessage: null });
    expect(statusCalls()).toHaveLength(2);
  });
});
