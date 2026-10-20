import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOSED_NETWORK_MESSAGE,
  CompetitorError,
  VIDEO_NOT_SUPPORTED_MESSAGE,
  BLUEPRINT_FAILED_MESSAGE,
  createCompetitorClient,
  normalizeCompetitorInput,
} from "./competitorMode";
import { ContentSourcesError } from "./contentSources";

// Competitor mode, the thin client side. Everything runs against a fake fetch: nothing touches a network.

const TOKEN = "tok_SECRET_session_value_123";
const BASE = "https://service.example";
const DASH = /[\u2013\u2014]/;

afterEach(() => vi.restoreAllMocks());

function reply(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(response: Response | Error, getToken: () => Promise<string> = async () => TOKEN) {
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response.clone();
  });
  const onUnauthorized = vi.fn();
  const client = createCompetitorClient({ baseUrl: BASE, getToken, fetchImpl: fetchImpl as unknown as typeof fetch, onUnauthorized });
  return { client, fetchImpl, onUnauthorized };
}

const good = {
  kind: "page",
  sourceUrl: "https://rival.example/pricing",
  title: "Rival pricing",
  blueprint: {
    hook: { type: "question", note: "It asks a question." },
    sections: [{ order: 1, role: "Problem", summary: "Names the pain." }],
    cta: { placement: "bottom", style: "One button", count: 1 },
    adjustments: ["Open with a question too."],
  },
  creditsUsed: 1,
};

describe("normalizeCompetitorInput", () => {
  it("accepts a full link and a bare domain", () => {
    expect(normalizeCompetitorInput("https://rival.example/pricing")).toEqual({ ok: true, input: "https://rival.example/pricing" });
    expect(normalizeCompetitorInput("  rival.example  ")).toEqual({ ok: true, input: "https://rival.example" });
  });

  it.each(["https://www.youtube.com/watch?v=abc123", "https://youtu.be/abc123", "https://m.youtube.com/watch?v=x", "youtube.com/shorts/abc", "https://music.youtube.com/watch?v=x"])(
    "catches the video link %s before the consent dialog, with the exact words, and sends nothing",
    (link) => {
      expect(normalizeCompetitorInput(link)).toEqual({ ok: false, error: VIDEO_NOT_SUPPORTED_MESSAGE, videoLink: true });
    },
  );

  it("does not mistake a similar looking website for a video site", () => {
    expect(normalizeCompetitorInput("https://notyoutube.com/page")).toMatchObject({ ok: true });
    expect(normalizeCompetitorInput("https://youtube.com.example/page")).toMatchObject({ ok: true });
  });

  it("uses the exact video wording", () => {
    expect(VIDEO_NOT_SUPPORTED_MESSAGE).toBe("Blueprints work on web pages and posts for now. Paste a page from their website.");
  });

  it("asks for a link when the box is empty", () => {
    const out = normalizeCompetitorInput("   ");
    expect(out).toMatchObject({ ok: false });
    expect((out as { error: string }).error).toMatch(/paste/i);
  });

  it.each([
    "https://www.tiktok.com/@someone/video/1",
    "https://vm.tiktok.com/abc",
    "https://www.instagram.com/someone/",
    "https://instagr.am/p/abc",
    "https://m.facebook.com/someone",
    "https://fb.watch/abc",
    "https://x.com/someone/status/1",
    "https://twitter.com/someone",
    "https://t.co/abc",
    "https://www.linkedin.com/company/rival",
    "https://lnkd.in/abc",
    "tiktok.com/@someone",
  ])("catches the closed network %s before anything is sent", (link) => {
    expect(normalizeCompetitorInput(link)).toEqual({ ok: false, error: CLOSED_NETWORK_MESSAGE, closedNetwork: true });
  });

  it("does not mistake a similar looking website for a closed network", () => {
    expect(normalizeCompetitorInput("https://notx.com/page")).toMatchObject({ ok: true });
    expect(normalizeCompetitorInput("https://mytiktok.com.example/page")).toMatchObject({ ok: true });
  });

  it("uses the exact closed network wording", () => {
    expect(CLOSED_NETWORK_MESSAGE).toBe("This network blocks public reading, so we can't analyze it. Paste a page from their website instead.");
  });

  it.each(["http://localhost/page", "https://127.0.0.1/", "https://user:pass@rival.example/", "ftp://rival.example/", "javascript:alert(1)", "not a link", "https://" + "a".repeat(2100) + ".example"])(
    "rejects %s with a plain sentence",
    (bad) => {
      const out = normalizeCompetitorInput(bad);
      expect(out.ok).toBe(false);
      expect((out as { error: string }).error).toMatch(/\w/);
    },
  );
});

describe("createCompetitorClient.blueprint", () => {
  it("posts the input with the bearer token, no cookies, and reads the answer", async () => {
    const { client, fetchImpl } = setup(reply(200, good));
    const out = await client.blueprint("https://rival.example/pricing");
    expect(out).toEqual(good);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/v1/blueprint`);
    const req = init as RequestInit & { headers: Record<string, string> };
    expect(req.method).toBe("POST");
    expect(req.credentials).toBe("omit");
    expect(req.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(req.body as string)).toEqual({ input: "https://rival.example/pricing" });
  });

  it("passes the abort signal on to the request", async () => {
    const { client, fetchImpl } = setup(reply(200, good));
    const controller = new AbortController();
    await client.blueprint("https://rival.example/", controller.signal);
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).signal).toBe(controller.signal);
  });

  it.each([
    ["no blueprint", { ...good, blueprint: undefined }],
    ["blueprint not an object", { ...good, blueprint: "x" }],
    ["a video kind", { ...good, kind: "youtube" }],
    ["credits not a number", { ...good, creditsUsed: "1" }],
    ["no title", { ...good, title: undefined }],
  ])("a malformed answer (%s) becomes a plain error", async (_name, body) => {
    const { client } = setup(reply(200, body));
    await expect(client.blueprint("https://rival.example/")).rejects.toMatchObject({ code: "bad_response" });
  });

  it("an answer that is not JSON becomes a plain error", async () => {
    const { client } = setup(new Response("<html>gateway</html>", { status: 200 }));
    await expect(client.blueprint("https://rival.example/")).rejects.toMatchObject({ code: "bad_response" });
  });

  it("a failed network call becomes a plain error and keeps the token out of it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client } = setup(new TypeError(`failed ${TOKEN}`));
    const err = await client.blueprint("https://rival.example/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CompetitorError);
    expect((err as CompetitorError).code).toBe("network");
    expect((err as CompetitorError).message).not.toContain(TOKEN);
  });

  it("an abort becomes the timeout error, not a network error", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const client = createCompetitorClient({ baseUrl: BASE, getToken: async () => TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.blueprint("https://rival.example/", controller.signal)).rejects.toMatchObject({ code: "timeout" });
  });

  it("makes no request when the session token cannot be had, and passes the plain sentence on", async () => {
    const getToken = async () => {
      throw new ContentSourcesError("sign_in");
    };
    const { client, fetchImpl } = setup(reply(200, good), getToken);
    await expect(client.blueprint("https://rival.example/")).rejects.toMatchObject({ code: "sign_in" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("tells the caller to drop the kept token on a 401", async () => {
    const { client, onUnauthorized } = setup(reply(401, { error: { code: "unauthorized", message: "no" } }));
    await expect(client.blueprint("https://rival.example/")).rejects.toMatchObject({ code: "sign_in" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe("the plain words for every error", () => {
  const ask = async (status: number, body?: unknown) => {
    const { client } = setup(reply(status, body));
    return (await client.blueprint("https://rival.example/").catch((e: unknown) => e)) as CompetitorError;
  };
  const shape = (code: string, message = "internal text") => ({ error: { code, message } });

  it("reads the nested error shape and the flat code shape", async () => {
    expect((await ask(402, shape("plan_limit"))).code).toBe("plan_limit");
    expect((await ask(402, { code: "plan_limit" })).code).toBe("plan_limit");
  });

  it.each([
    ["plan_limit", 402, /upgrade/i],
    ["cooldown", 429, /moment/i],
    ["daily_limit", 429, /tomorrow/i],
    ["page_blocked", 422, /does not let us read/i],
    ["reader_timeout", 504, /(too long|slow)/i],
    ["reader_unavailable", 503, /(not available|try again)/i],
    ["competitor_mode_unavailable", 503, /^This feature is not switched on yet/],
    ["blueprint_not_supported", 422, /^Blueprints work on web pages and posts for now\. Paste a page from their website\.$/],
    ["blueprint_invalid", 422, /^We could not build a blueprint for that page, try another page$/],
    ["draft_unavailable", 422, /^We could not build a blueprint for that page, try another page$/],
    ["draft_unsafe", 422, /^We could not build a blueprint for that page, try another page$/],
    ["invalid_input", 400, /link/i],
  ])("%s (HTTP %i) becomes a plain sentence", async (code, status, pattern) => {
    const err = await ask(status, shape(code));
    expect(err).toBeInstanceOf(CompetitorError);
    expect(err.message).toMatch(pattern);
    expect(err.message).not.toContain(code);
    expect(err.message).not.toContain("internal text");
    expect(err.message).not.toMatch(DASH);
    expect(err.message).not.toMatch(/(^|[^a-z])(safe|draft|guarantee[ds]?|accurate|instant(ly)?)([^a-z]|$)/i);
  });

  it("ignores the server's own sentence for the new codes, so only our words show", async () => {
    expect((await ask(422, shape("blueprint_not_supported", "internal text"))).message).toBe(VIDEO_NOT_SUPPORTED_MESSAGE);
    expect((await ask(422, shape("blueprint_invalid", "internal text"))).message).toBe(BLUEPRINT_FAILED_MESSAGE);
  });

  it("uses the server's own sentence for network_not_supported, kept plain", async () => {
    const err = await ask(422, shape("network_not_supported", "That network is closed \u2014 try their website."));
    expect(err.code).toBe("network_not_supported");
    expect(err.message).toBe("That network is closed - try their website.");
  });

  it("falls back to the built in closed network sentence when the server sentence is missing or huge", async () => {
    expect((await ask(422, { error: { code: "network_not_supported" } })).message).toBe(CLOSED_NETWORK_MESSAGE);
    expect((await ask(422, shape("network_not_supported", "x".repeat(500)))).message).toBe(CLOSED_NETWORK_MESSAGE);
  });

  it("an unknown code, a gateway page and a 500 never show raw text", async () => {
    const odd = await ask(418, shape("teapot_overflow", "Traceback (most recent call last): boom"));
    expect(odd.message).not.toMatch(/teapot|Traceback|boom/);
    const gateway = await ask(502, undefined);
    expect(gateway.message).toMatch(/try again/i);
    const five = await ask(500, { stack: "at Object.<anonymous>" });
    expect(five.message).not.toMatch(/stack|Object/);
  });

  it("a 400 with an unknown code still says what to fix", async () => {
    expect((await ask(400, shape("weird_thing"))).message).toMatch(/link/i);
  });
});
