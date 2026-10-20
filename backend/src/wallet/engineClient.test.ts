import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { createEngineClient, EngineError, ENGINE_TOKEN_TTL_SECONDS } from "./engineClient.js";

type Jwk = import("node:crypto").webcrypto.JsonWebKey;
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const privateJwk = { ...(privateKey.export({ format: "jwk" }) as Jwk), kid: "eng-kid", alg: "ES256", use: "sig" };
const publicJwk = { ...(createPublicKey(privateKey).export({ format: "jwk" }) as Jwk), kid: "eng-kid", alg: "ES256", use: "sig" };

const saved = { a: process.env.CONTENT_SOURCES_SIGNING_KEY_JWK, b: process.env.CONTENT_SOURCES_PUBLIC_JWK };
beforeAll(() => {
  process.env.CONTENT_SOURCES_SIGNING_KEY_JWK = JSON.stringify(privateJwk);
  process.env.CONTENT_SOURCES_PUBLIC_JWK = JSON.stringify(publicJwk);
});
afterAll(() => {
  for (const [k, v] of [["CONTENT_SOURCES_SIGNING_KEY_JWK", saved.a], ["CONTENT_SOURCES_PUBLIC_JWK", saved.b]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
const ident = { userId: "user-1", accountId: "acc-1", tier: "free" as const };
const NOW = new Date("2026-10-20T10:00:00.000Z");

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("engine client", () => {
  it("sends a bearer token with srv: true and a lifetime of at most 120 seconds, signed so the public key verifies it", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { ok: 1 }));
    const c = createEngineClient({ baseUrl: "https://engine.test", fetchImpl: fetchImpl as never, now: () => NOW });
    await c.analyze(ident, "https://rival.example");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://engine.test/v1/analyze");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ input: "https://rival.example" });
    const token = (init.headers as Record<string, string>).authorization.replace(/^Bearer /, "");
    const [h, p, s] = token.split(".");
    const claims = json(p);
    expect(claims.srv).toBe(true);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(120);
    expect(ENGINE_TOKEN_TTL_SECONDS).toBe(120);
    expect(claims).toMatchObject({ sub: "user-1", acc: "acc-1", tier: "free", aud: "content-sources" });
    expect(json(h)).toEqual({ alg: "ES256", typ: "JWT", kid: "eng-kid" });
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: publicJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("calls /v1/blueprint with the same body shape and returns the parsed answer", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { blueprint: "x" }));
    const c = createEngineClient({ baseUrl: "https://engine.test/", fetchImpl: fetchImpl as never, now: () => NOW });
    expect(await c.blueprint(ident, "https://rival.example")).toEqual({ blueprint: "x" });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://engine.test/v1/blueprint");
  });

  it("surfaces the raw engine error: status, code and message, nothing swallowed", async () => {
    const fetchImpl = vi.fn(async () => reply(503, { code: "competitor_mode_unavailable", message: "Blueprints are not available right now." }));
    const c = createEngineClient({ baseUrl: "https://engine.test", fetchImpl: fetchImpl as never, now: () => NOW });
    const err = await c.blueprint(ident, "https://rival.example").catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.status).toBe(503);
    expect(err.code).toBe("competitor_mode_unavailable");
    expect(err.message).toContain("Blueprints are not available right now.");
  });

  it("surfaces a network failure as an EngineError that keeps the original cause", async () => {
    const boom = new Error("socket hang up");
    const c = createEngineClient({ baseUrl: "https://engine.test", fetchImpl: (async () => { throw boom; }) as never, now: () => NOW });
    const err = await c.analyze(ident, "https://rival.example").catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.code).toBe("unreachable");
    expect(err.cause).toBe(boom);
  });

  it("times out instead of waiting forever", async () => {
    const fetchImpl = (async (_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as never;
    const c = createEngineClient({ baseUrl: "https://engine.test", fetchImpl, now: () => NOW, timeoutMs: 20 });
    const err = await c.analyze(ident, "https://rival.example").catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.code).toBe("timeout");
  });

  it("refuses to run with no engine address (a loud error, not a silent default)", async () => {
    const c = createEngineClient({ baseUrl: "", fetchImpl: vi.fn() as never, now: () => NOW });
    await expect(c.analyze(ident, "https://rival.example")).rejects.toThrow(/CONTENT_SOURCES_API_URL/);
  });
});
