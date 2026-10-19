import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContentSourcesError,
  createNotConnectedClient,
  createServiceClient,
  createSessionTokenProvider,
  describeVerifyReasons,
  describeLastProblem,
  validateApiKey,
} from "./contentSources";
import { createMockContentSourcesClient } from "./contentSourcesMock";

// The client that talks to the companion service. Everything here runs against a fake fetch: nothing touches a network.

const TOKEN = "tok_SECRET_session_value_123";
const BASE = "https://service.example";
const DASH = /[\u2013\u2014]/;
const ID = "11111111-2222-4333-8444-555555555555";

afterEach(() => vi.restoreAllMocks());

function reply(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function setup(responses: Array<Response | Error> | Response | Error, opts: { onUnauthorized?: () => void; baseUrl?: string } = {}) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next instanceof Error) throw next;
    return next.clone();
  });
  const getToken = vi.fn(async () => TOKEN);
  const client = createServiceClient({ baseUrl: opts.baseUrl ?? BASE, getToken, fetchImpl: fetchImpl as unknown as typeof fetch, onUnauthorized: opts.onUnauthorized });
  return { client, fetchImpl, getToken };
}

const lastCall = (f: ReturnType<typeof setup>["fetchImpl"]) => {
  const [url, init] = f.mock.calls[f.mock.calls.length - 1]!;
  return { url, init: init as RequestInit & { headers: Record<string, string> } };
};

const sourceJson = (over: Record<string, unknown> = {}) => ({
  id: ID,
  sourceType: "rss",
  sourceUrl: "https://example.com/feed.xml",
  syncInterval: "daily",
  brandId: null,
  lastSyncedAt: null,
  domainVerified: false,
  verificationMethod: null,
  lastError: null,
  consecutiveFailures: 0,
  verificationToken: "proof-token-1",
  ...over,
});

const verificationJson = {
  token: "proof-token-1",
  methods: {
    well_known: { url: "https://example.com/.well-known/proof-example.txt", content: "proof-token-1" },
    meta_tag: { html: '<meta name="proof-example" content="proof-token-1">', placement: "inside <head> of https://example.com/" },
    dns_txt: { name: "_proof-example.example.com", value: "proof-example=proof-token-1" },
  },
};

async function errorOf(p: Promise<unknown>): Promise<ContentSourcesError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ContentSourcesError);
  return e as ContentSourcesError;
}

describe("every request", () => {
  it("sends the bearer token, asks for JSON, never sends cookies, and uses the https base without a trailing slash", async () => {
    const { client, fetchImpl, getToken } = setup(reply(200, { registered: false, keyHint: null }), { baseUrl: "https://service.example///" });
    await client.getCredentials();
    const { url, init } = lastCall(fetchImpl);
    expect(url).toBe("https://service.example/v1/credentials");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("omit");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers.Accept).toBe("application/json");
    expect(init.headers["Content-Type"]).toBeUndefined(); // no body, so no content type
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("keeps a path on the base address", async () => {
    const { client, fetchImpl } = setup(reply(200, { sources: [] }), { baseUrl: "https://service.example/api/" });
    await client.listSources();
    expect(lastCall(fetchImpl).url).toBe("https://service.example/api/v1/sources");
  });

  it("refuses an address that is not https", () => {
    for (const bad of ["http://service.example", "service.example", "", "ftp://x.example"]) {
      expect(() => createServiceClient({ baseUrl: bad, getToken: async () => TOKEN })).toThrow();
    }
  });

  it("sends JSON with a content type when there is a body", async () => {
    const { client, fetchImpl } = setup(reply(201, { keyHint: "wxyz" }));
    await client.saveKey("lzr_live_abcdefghijklmnop");
    expect(lastCall(fetchImpl).init.headers["Content-Type"]).toBe("application/json");
  });
});

describe("credentials", () => {
  it("GET /v1/credentials returns registered and keyHint", async () => {
    const a = setup(reply(200, { registered: true, keyHint: "wxyz" }));
    expect(await a.client.getCredentials()).toEqual({ registered: true, keyHint: "wxyz" });
    const b = setup(reply(200, { registered: false, keyHint: null }));
    expect(await b.client.getCredentials()).toEqual({ registered: false, keyHint: null });
  });

  it("rejects a credentials answer of the wrong shape", async () => {
    for (const bad of [{ registered: "yes", keyHint: null }, { keyHint: "abcd" }, [], "x", { registered: true, keyHint: 5 }]) {
      const e = await errorOf(setup(reply(200, bad)).client.getCredentials());
      expect(e.code).toBe("bad_response");
    }
  });

  it("POST /v1/credentials sends {apiKey} and returns the 201 keyHint", async () => {
    const { client, fetchImpl } = setup(reply(201, { keyHint: "wxyz" }));
    expect(await client.saveKey("lzr_live_abcdefghijklmnop")).toEqual({ keyHint: "wxyz" });
    const { url, init } = lastCall(fetchImpl);
    expect(url).toBe(`${BASE}/v1/credentials`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ apiKey: "lzr_live_abcdefghijklmnop" });
  });

  it("never puts the key in an error, even when the service echoes it back", async () => {
    const key = "lzr_live_abcdefghijklmnop";
    const e = await errorOf(setup(reply(400, { code: "api_key_rejected", message: `LazyRelay did not accept ${key}` })).client.saveKey(key));
    expect(e.code).toBe("api_key_rejected");
    expect(e.message).not.toContain(key);
    expect(JSON.stringify(e)).not.toContain(key);
  });

  it("DELETE /v1/credentials resolves on 204", async () => {
    const { client, fetchImpl } = setup(reply(204));
    await expect(client.removeKey()).resolves.toBeUndefined();
    expect(lastCall(fetchImpl).init.method).toBe("DELETE");
    expect(lastCall(fetchImpl).url).toBe(`${BASE}/v1/credentials`);
  });
});

describe("sources", () => {
  it("GET /v1/sources returns typed rows and keeps the proof token only on a waiting source", async () => {
    const verified = sourceJson({ id: "aaaaaaaa-2222-4333-8444-555555555555", domainVerified: true, verificationMethod: "dns_txt", lastSyncedAt: "2026-10-18T08:00:00.000Z", verificationToken: undefined });
    const { client } = setup(reply(200, { sources: [sourceJson(), verified] }));
    const rows = await client.listSources();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: ID, sourceType: "rss", domainVerified: false, verificationToken: "proof-token-1", lastError: null });
    expect(rows[1]).toMatchObject({ domainVerified: true, verificationMethod: "dns_txt", lastSyncedAt: "2026-10-18T08:00:00.000Z" });
    expect(rows[1]!.verificationToken).toBeNull();
  });

  it("rejects a sources answer that is not a list of valid rows", async () => {
    for (const bad of [{}, { sources: "no" }, { sources: [{ id: 5 }] }, { sources: [sourceJson({ sourceType: "pdf" })] }, { sources: [sourceJson({ domainVerified: "yes" })] }]) {
      expect((await errorOf(setup(reply(200, bad)).client.listSources())).code).toBe("bad_response");
    }
  });

  it("POST /v1/sources sends only what was given and returns the source and the three proof methods", async () => {
    const { client, fetchImpl } = setup(reply(201, { source: sourceJson(), verification: verificationJson }));
    const out = await client.createSource({ sourceType: "rss", sourceUrl: "https://example.com/feed.xml" });
    expect(JSON.parse(lastCall(fetchImpl).init.body as string)).toEqual({ sourceType: "rss", sourceUrl: "https://example.com/feed.xml" });
    expect(lastCall(fetchImpl).init.method).toBe("POST");
    expect(out.source.id).toBe(ID);
    expect(out.verification.methods.well_known).toEqual(verificationJson.methods.well_known);
    expect(out.verification.methods.meta_tag.html).toContain("proof-token-1");
    expect(out.verification.methods.dns_txt.name).toBe("_proof-example.example.com");
    expect(out.verification.token).toBe("proof-token-1");

    const b = setup(reply(201, { source: sourceJson(), verification: verificationJson }));
    await b.client.createSource({ sourceType: "sitemap", sourceUrl: "https://example.com/sitemap.xml", syncInterval: "hourly", brandId: "b-1" });
    expect(JSON.parse(lastCall(b.fetchImpl).init.body as string)).toEqual({ sourceType: "sitemap", sourceUrl: "https://example.com/sitemap.xml", syncInterval: "hourly", brandId: "b-1" });
  });

  it("rejects a create answer without the proof methods", async () => {
    const e = await errorOf(setup(reply(201, { source: sourceJson(), verification: { token: "t", methods: {} } })).client.createSource({ sourceType: "rss", sourceUrl: "https://example.com/f" }));
    expect(e.code).toBe("bad_response");
  });

  it("POST /v1/sources/:id/verify returns verified with the method, or the reasons", async () => {
    const ok = setup(reply(200, { verified: true, method: "well_known" }));
    expect(await ok.client.verifySource(ID)).toEqual({ verified: true, method: "well_known" });
    expect(lastCall(ok.fetchImpl).url).toBe(`${BASE}/v1/sources/${ID}/verify`);
    expect(lastCall(ok.fetchImpl).init.method).toBe("POST");

    const reasons = { well_known: "file is empty", meta_tag: "no matching meta tag in the head", dns_txt: "no matching TXT record" };
    const no = setup(reply(200, { verified: false, reasons }));
    expect(await no.client.verifySource(ID)).toEqual({ verified: false, reasons });
  });

  it("rejects a verify answer of the wrong shape", async () => {
    for (const bad of [{}, { verified: true }, { verified: false }, { verified: false, reasons: { well_known: 1 } }, { verified: true, method: "carrier_pigeon" }]) {
      expect((await errorOf(setup(reply(200, bad)).client.verifySource(ID))).code).toBe("bad_response");
    }
  });

  it("PATCH /v1/sources/:id sends the change and returns the source", async () => {
    const { client, fetchImpl } = setup(reply(200, { source: sourceJson({ syncInterval: "hourly" }) }));
    const row = await client.updateSource(ID, { syncInterval: "hourly", brandId: null });
    expect(row.syncInterval).toBe("hourly");
    expect(lastCall(fetchImpl).init.method).toBe("PATCH");
    expect(lastCall(fetchImpl).url).toBe(`${BASE}/v1/sources/${ID}`);
    expect(JSON.parse(lastCall(fetchImpl).init.body as string)).toEqual({ syncInterval: "hourly", brandId: null });
  });

  it("DELETE /v1/sources/:id resolves on 204", async () => {
    const { client, fetchImpl } = setup(reply(204));
    await expect(client.deleteSource(ID)).resolves.toBeUndefined();
    expect(lastCall(fetchImpl).init.method).toBe("DELETE");
  });

  it("POST /v1/sources/:id/run resolves on 202", async () => {
    const { client, fetchImpl } = setup(reply(202, { accepted: true }));
    await expect(client.runSource(ID)).resolves.toBeUndefined();
    expect(lastCall(fetchImpl).url).toBe(`${BASE}/v1/sources/${ID}/run`);
    expect(lastCall(fetchImpl).init.method).toBe("POST");
  });

  it("encodes an id so it cannot change the path", async () => {
    const { client, fetchImpl } = setup(reply(204));
    await client.deleteSource("a/../b");
    expect(lastCall(fetchImpl).url).toBe(`${BASE}/v1/sources/a%2F..%2Fb`);
  });
});

describe("every error code becomes a safe error with a plain message", () => {
  const cases: Array<[number, string]> = [
    [400, "invalid_request"],
    [400, "invalid_json"],
    [400, "invalid_sync_interval"],
    [400, "invalid_brand_id"],
    [400, "invalid_api_key"],
    [400, "api_key_rejected"],
    [400, "invalid_source_type"],
    [400, "invalid_source_url"],
    [400, "address_not_editable"],
    [401, "unauthorized"],
    [403, "plan_limit"],
    [403, "forbidden_origin"],
    [404, "not_found"],
    [405, "method_not_allowed"],
    [409, "duplicate_source"],
    [409, "not_verifiable"],
    [409, "engine_disabled"],
    [409, "not_verified"],
    [409, "no_credential"],
    [409, "already_running"],
    [413, "payload_too_large"],
    [415, "unsupported_media_type"],
    [500, "internal"],
    [501, "not_available"],
    [503, "unavailable"],
    [503, "not_ready"],
  ];

  it.each(cases)("%i %s", async (status, code) => {
    const { client } = setup(reply(status, { code, message: `server words with ${TOKEN} and a dash \u2014 here` }));
    const e = await errorOf(client.runSource(ID));
    expect(e.code).toBe(code);
    expect(e.message.length).toBeGreaterThan(10);
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).not.toMatch(DASH);
    expect(e.message).not.toMatch(/server words/);
    expect(e.message).not.toMatch(/scraper|crawler/i);
    expect(e).not.toHaveProperty("token");
  });

  it("writes the exact wording the brief asks for on the run codes", async () => {
    expect((await errorOf(setup(reply(409, { code: "engine_disabled" })).client.runSource(ID))).message).toBe("Background runs are switched off right now.");
  });

  it("429 carries the wait time from Retry-After and says it in the message", async () => {
    const e = await errorOf(setup(reply(429, { code: "rate_limited" }, { "retry-after": "45" })).client.runSource(ID));
    expect(e.code).toBe("rate_limited");
    expect(e.retryAfterSeconds).toBe(45);
    expect(e.message).toContain("45 seconds");
  });

  it("429 without a usable Retry-After still gives a plain message", async () => {
    const headers: Array<Record<string, string>> = [{}, { "retry-after": "soon" }, { "retry-after": "-5" }, { "retry-after": "0" }];
    for (const header of headers) {
      const e = await errorOf(setup(reply(429, { code: "rate_limited" }, header)).client.runSource(ID));
      expect(e.code).toBe("rate_limited");
      expect(e.retryAfterSeconds).toBeUndefined();
      expect(e.message).toMatch(/wait a moment/i);
    }
  });

  it("says one second in the singular", async () => {
    const e = await errorOf(setup(reply(429, { code: "rate_limited" }, { "retry-after": "1" })).client.runSource(ID));
    expect(e.message).toContain("1 second");
    expect(e.message).not.toContain("1 seconds");
  });

  it("an unknown code keeps its status meaning, never the service words", async () => {
    const e = await errorOf(setup(reply(418, { code: "teapot", message: "I am a teapot" })).client.runSource(ID));
    expect(e.code).toBe("unknown");
    expect(e.message).not.toContain("teapot");
  });

  it("a body that is not JSON falls back on the status", async () => {
    const e401 = await errorOf(setup(new Response("<html>bad gateway</html>", { status: 401 })).client.runSource(ID));
    expect(e401.code).toBe("unauthorized");
    const e502 = await errorOf(setup(new Response("<html>bad gateway</html>", { status: 502 })).client.runSource(ID));
    expect(e502.code).toBe("unavailable");
    expect(e502.message).not.toContain("html");
    const e429 = await errorOf(setup(new Response("slow down", { status: 429 })).client.runSource(ID));
    expect(e429.code).toBe("rate_limited");
  });

  it("a code that is not a plain code word is ignored", async () => {
    const e = await errorOf(setup(reply(409, { code: `<script>${TOKEN}</script>` })).client.runSource(ID));
    expect(e.code).toBe("unknown");
    expect(e.message).not.toContain(TOKEN);
  });

  it("a 2xx answer that is not JSON is a bad response, and no body text is echoed", async () => {
    const e = await errorOf(setup(new Response("not json at all", { status: 200 })).client.listSources());
    expect(e.code).toBe("bad_response");
    expect(e.message).not.toContain("not json");
  });

  it("a network failure is a plain network error, the raw error goes to the console, and the token is not in either", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = await errorOf(setup(new TypeError("Failed to fetch")).client.listSources());
    expect(e.code).toBe("network");
    expect(e.message).not.toContain(TOKEN);
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls.map((c) => String(c[0])))).not.toContain(TOKEN);
  });

  it("a 401 tells the caller to drop its cached token, so the next call asks for a fresh one", async () => {
    const onUnauthorized = vi.fn();
    const e = await errorOf(setup(reply(401, { code: "unauthorized" }), { onUnauthorized }).client.listSources());
    expect(e.code).toBe("unauthorized");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("when the session token cannot be had, no request is made and its own error comes through", async () => {
    const fetchImpl = vi.fn();
    const boom = new ContentSourcesError("not_connected");
    const client = createServiceClient({ baseUrl: BASE, getToken: async () => Promise.reject(boom), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await errorOf(client.listSources())).toBe(boom);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("no error object, however it was made, contains the session token", async () => {
    for (const [status, code] of cases) {
      const e = await errorOf(setup(reply(status, { code, message: TOKEN })).client.listSources());
      expect(`${e.name} ${e.message} ${e.code} ${JSON.stringify(e)} ${e.stack?.split("\n")[0]}`).not.toContain(TOKEN);
    }
  });
});

describe("the not connected client", () => {
  it("answers every call with Not connected yet and never touches the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createNotConnectedClient();
    for (const call of [
      () => client.getCredentials(),
      () => client.saveKey("lzr_live_abcdefghijklmnop"),
      () => client.removeKey(),
      () => client.listSources(),
      () => client.createSource({ sourceType: "rss", sourceUrl: "https://example.com/f" }),
      () => client.verifySource(ID),
      () => client.updateSource(ID, { brandId: null }),
      () => client.deleteSource(ID),
      () => client.runSource(ID),
    ]) {
      const e = await errorOf(call());
      expect(e.code).toBe("not_connected");
      expect(e.message).toMatch(/^Not connected yet/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("session token provider", () => {
  const session = (over: Record<string, unknown> = {}) => ({ token: TOKEN, expiresAt: new Date(NOW + 10 * 60_000).toISOString(), ...over });
  const NOW = Date.parse("2026-10-19T10:00:00.000Z");

  function provider(fetchSession: () => Promise<unknown>, clock = { t: NOW }) {
    return { clock, p: createSessionTokenProvider({ fetchSession: fetchSession as () => Promise<{ token: string; expiresAt: string }>, now: () => clock.t }) };
  }

  it("returns the token and reuses it until 30 seconds before it expires", async () => {
    const fetchSession = vi.fn(async () => session());
    const { p, clock } = provider(fetchSession);
    expect(await p.getToken()).toBe(TOKEN);
    expect(await p.getToken()).toBe(TOKEN);
    expect(fetchSession).toHaveBeenCalledTimes(1);
    clock.t = NOW + 10 * 60_000 - 31_000; // 31 seconds left: still good
    await p.getToken();
    expect(fetchSession).toHaveBeenCalledTimes(1);
    clock.t = NOW + 10 * 60_000 - 30_000; // exactly 30 seconds left: ask again
    await p.getToken();
    expect(fetchSession).toHaveBeenCalledTimes(2);
  });

  it("shares one request between calls made at the same time", async () => {
    let finish!: (v: unknown) => void;
    const fetchSession = vi.fn(() => new Promise((res) => (finish = res)));
    const { p } = provider(fetchSession);
    const all = Promise.all([p.getToken(), p.getToken(), p.getToken()]);
    finish(session());
    expect(await all).toEqual([TOKEN, TOKEN, TOKEN]);
    expect(fetchSession).toHaveBeenCalledTimes(1);
  });

  it("a token that is already inside the 30 seconds is used once and not kept", async () => {
    const fetchSession = vi.fn(async () => session({ expiresAt: new Date(NOW + 10_000).toISOString() }));
    const { p } = provider(fetchSession);
    expect(await p.getToken()).toBe(TOKEN);
    await p.getToken();
    expect(fetchSession).toHaveBeenCalledTimes(2);
  });

  it("invalidate makes the next call ask again", async () => {
    const fetchSession = vi.fn(async () => session());
    const { p } = provider(fetchSession);
    await p.getToken();
    p.invalidate();
    await p.getToken();
    expect(fetchSession).toHaveBeenCalledTimes(2);
  });

  it("a failed request is not kept, and the next call tries again", async () => {
    const fetchSession = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Request failed: 503"), { status: 503 }))
      .mockResolvedValueOnce(session());
    const { p } = provider(fetchSession);
    expect((await errorOf(p.getToken())).code).toBe("try_later");
    expect(await p.getToken()).toBe(TOKEN);
  });

  it("404 means the feature is switched off for now: Not connected yet", async () => {
    const { p } = provider(async () => Promise.reject(Object.assign(new Error("Request failed: 404"), { status: 404 })));
    const e = await errorOf(p.getToken());
    expect(e.code).toBe("not_connected");
    expect(e.message).toMatch(/^Not connected yet/);
  });

  it("401 and a missing sign in mean sign in again; 503 means try later; anything else is a plain failure", async () => {
    const cases: Array<[Error, string]> = [
      [Object.assign(new Error("Request failed: 401"), { status: 401 }), "sign_in"],
      [new Error("Not signed in"), "sign_in"],
      [Object.assign(new Error("Request failed: 503"), { status: 503 }), "try_later"],
      [Object.assign(new Error("Request failed: 500"), { status: 500 }), "internal"],
      [new TypeError("Failed to fetch"), "network"],
    ];
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [err, code] of cases) {
      const { p } = provider(async () => Promise.reject(err));
      expect((await errorOf(p.getToken())).code, err.message).toBe(code);
    }
  });

  it("rejects a session answer of the wrong shape, without echoing it", async () => {
    for (const bad of [null, {}, { token: "" , expiresAt: "2026-10-19T10:10:00Z" }, { token: TOKEN }, { token: TOKEN, expiresAt: "not a date" }, { token: 5, expiresAt: "2026-10-19T10:10:00Z" }]) {
      const { p } = provider(async () => bad);
      const e = await errorOf(p.getToken());
      expect(e.code).toBe("bad_response");
      expect(e.message).not.toContain(TOKEN);
    }
  });

  it("never stores the token and never logs it", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { p } = provider(async () => session());
    await p.getToken();
    await p.getToken();
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain(TOKEN);
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain(TOKEN);
    for (const l of logs) expect(JSON.stringify(l.mock.calls)).not.toContain(TOKEN);
  });
});

describe("validateApiKey (the same shape check the service makes)", () => {
  it("accepts lzr_live_ plus 16 to 128 safe characters, and trims", () => {
    expect(validateApiKey("  lzr_live_abcdefghijklmnop  ")).toEqual({ ok: true, key: "lzr_live_abcdefghijklmnop" });
    expect(validateApiKey(`lzr_live_${"a".repeat(128)}`).ok).toBe(true);
    expect(validateApiKey("lzr_live_AZaz09_-AZaz09_-").ok).toBe(true);
  });

  it("rejects a missing prefix, a short or long tail, unsafe characters and blanks", () => {
    for (const bad of ["", "   ", "abcdefghijklmnopqrstuvwxyz", "lzr_test_abcdefghijklmnop", `lzr_live_${"a".repeat(15)}`, `lzr_live_${"a".repeat(129)}`, "lzr_live_abcdefgh ijklmnop", "lzr_live_abcdefgh.ijklmnop", "lzr_live_abcdefghijklmnoé"]) {
      const r = validateApiKey(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) {
        expect(r.error).not.toMatch(DASH);
        expect(r.error).not.toContain(bad.trim() || "\u0000");
      }
    }
  });
});

describe("plain words for what the engine and the proof check report", () => {
  it("describeVerifyReasons maps every known reason to a plain sentence and never shows raw text it cannot map", () => {
    const known = describeVerifyReasons({ well_known: "http status 404", meta_tag: "no matching meta tag in the head", dns_txt: "no matching TXT record" });
    expect(known.map((r) => r.method)).toEqual(["well_known", "meta_tag", "dns_txt"]);
    for (const r of known) {
      expect(r.text.length).toBeGreaterThan(15);
      expect(r.text).not.toMatch(DASH);
    }
    expect(known[0]!.text).toMatch(/text file/i);
    expect(known[1]!.text).toMatch(/tag/i);
    expect(known[2]!.text).toMatch(/DNS/);

    const odd = describeVerifyReasons({ well_known: "ECONNRESET 10.0.0.5 stack at x", meta_tag: "<b>bad</b>", dns_txt: "not attempted" });
    for (const r of odd) {
      expect(r.text).not.toMatch(/ECONNRESET|10\.0\.0\.5|<b>|not attempted/);
      expect(r.text.length).toBeGreaterThan(15);
    }
  });

  it("covers every reason the checker can give", () => {
    const wk = ["fetch failed", "fetch refused (host_mismatch)", "http status 404", "http status 500", "file is empty", "file does not contain the verification token"];
    const mt = ["home page could not be parsed", "home page has no head", "no matching meta tag in the head", "http status 403", "fetch failed"];
    const dns = ["dns lookup failed", "dns lookup failed (ENOTFOUND)", "no matching TXT record"];
    const texts = new Set<string>();
    for (const r of wk) texts.add(describeVerifyReasons({ well_known: r, meta_tag: "x", dns_txt: "x" })[0]!.text);
    for (const r of mt) texts.add(describeVerifyReasons({ well_known: "x", meta_tag: r, dns_txt: "x" })[1]!.text);
    for (const r of dns) texts.add(describeVerifyReasons({ well_known: "x", meta_tag: "x", dns_txt: r })[2]!.text);
    expect(texts.size).toBeGreaterThanOrEqual(8);
    for (const t of texts) expect(t).not.toMatch(DASH);
  });

  it("describeLastProblem maps the engine's codes and falls back to a generic line", () => {
    const codes = ["no_credential", "not_verified", "fetch:timeout", "fetch:blocked", "parse:empty", "lazyrelay:bad_key", "lazyrelay:plan_or_not_allowed", "lazyrelay:rate_limited", "lazyrelay:bad_request", "lazyrelay:upstream", "internal"];
    const seen = new Set<string>();
    for (const c of codes) {
      const t = describeLastProblem(c);
      expect(t.length).toBeGreaterThan(15);
      expect(t).not.toMatch(DASH);
      expect(t).not.toMatch(/scraper|crawler/i);
      expect(t).not.toContain(":");
      seen.add(t);
    }
    expect(seen.size).toBeGreaterThanOrEqual(8);
    expect(describeLastProblem("Something odd with lzr_live_xx")).not.toContain("lzr_live");
    expect(describeLastProblem(null)).toBe("");
  });
});

describe("mock client (tests and manual development only)", () => {
  it("answers with defaults and lets a test override one call", async () => {
    const base = createMockContentSourcesClient();
    expect(await base.getCredentials()).toEqual({ registered: true, keyHint: "abcd" });
    expect(await base.listSources()).toEqual([]);
    const custom = createMockContentSourcesClient({ getCredentials: async () => ({ registered: false, keyHint: null }) });
    expect(await custom.getCredentials()).toEqual({ registered: false, keyHint: null });
  });
});
