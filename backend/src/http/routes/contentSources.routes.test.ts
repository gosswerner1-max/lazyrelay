// The session-token routes for a companion service: switched off means invisible, people only (never an API key),
// a per-user limit, and a clean 503 that never carries key material. Login, tier and the standard limiter are mocked;
// every key is generated at run time and thrown away.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";

type Jwk = import("node:crypto").webcrypto.JsonWebKey;

const auth = vi.hoisted(() => ({ mode: "jwt" as "none" | "jwt" | "apiKey", userId: "user-1", accountId: "acc-1", role: "owner" as "owner" | "member" }));
vi.mock("../auth.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../auth.js")>();
  return {
    ...real,
    requireAuth: (req: any, res: any, next: any) => {
      if (auth.mode === "none") {
        res.status(401).json({ error: "Missing or invalid credentials" });
        return;
      }
      req.authMethod = auth.mode;
      req.userId = auth.userId;
      req.accountId = auth.accountId;
      req.role = auth.role;
      next();
    },
  };
});
vi.mock("../rateLimit.js", () => ({
  tieredRateLimit: (_req: any, _res: any, next: any) => next(),
  publicRateLimit: (_req: any, _res: any, next: any) => next(),
}));
const tierMock = vi.hoisted(() => ({ resolveTier: vi.fn(async (_accountId: string) => "business") }));
vi.mock("../../tier.js", () => tierMock);
vi.mock("../securityAlerts.js", () => ({ recordSecurityEvent: () => {} }));

const { buildContentSourcesRouter } = await import("./contentSources.routes.js");

const NOW = new Date("2026-10-19T10:00:00.000Z");
const mount = (withRouter = true) => {
  const a = express();
  a.use(express.json());
  if (withRouter) a.use(buildContentSourcesRouter({ now: () => NOW }));
  return a;
};

function makePair(kid = "route-kid", namedCurve: "P-256" | "P-384" = "P-256") {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve });
  const priv = privateKey.export({ format: "jwk" }) as Jwk;
  const pub = createPublicKey(privateKey).export({ format: "jwk" }) as Jwk;
  return { privateJwk: { ...priv, kid, alg: "ES256", use: "sig" }, publicJwk: { ...pub, kid, alg: "ES256", use: "sig" } };
}
const good = makePair();
const other = makePair();
const wrongCurve = makePair("route-kid", "P-384");

const ENV_NAMES = ["CONTENT_SOURCES_SIGNING_KEY_JWK", "CONTENT_SOURCES_PUBLIC_JWK", "CONTENT_SOURCES_TOKENS_ENABLED"] as const;
const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
const configure = (priv: unknown, pub: unknown) => {
  process.env.CONTENT_SOURCES_SIGNING_KEY_JWK = JSON.stringify(priv);
  process.env.CONTENT_SOURCES_PUBLIC_JWK = JSON.stringify(pub);
};

const logged: string[] = [];
beforeEach(() => {
  auth.mode = "jwt";
  auth.userId = "user-1";
  auth.accountId = "acc-1";
  auth.role = "owner";
  tierMock.resolveTier.mockClear();
  logged.length = 0;
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  process.env.CONTENT_SOURCES_TOKENS_ENABLED = "true";
  configure(good.privateJwk, good.publicJwk);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const n of ENV_NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

const mint = (app = mount()) => request(app).post("/content-sources/session");
const b64urlJson = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

describe("flag off: the feature is invisible", () => {
  it("answers exactly like a route that does not exist, on both routes and for every caller", async () => {
    process.env.CONTENT_SOURCES_TOKENS_ENABLED = "false";
    for (const mode of ["none", "jwt", "apiKey"] as const) {
      auth.mode = mode;
      const post = await mint();
      const postUnknown = await request(mount(false)).post("/content-sources/session");
      expect(post.status, mode).toBe(404);
      expect(post.text).toBe(postUnknown.text);
      expect(post.headers["content-type"]).toBe(postUnknown.headers["content-type"]);
      const get = await request(mount()).get("/content-sources/jwks");
      const getUnknown = await request(mount(false)).get("/content-sources/jwks");
      expect(get.status, mode).toBe(404);
      expect(get.text).toBe(getUnknown.text);
    }
    expect(tierMock.resolveTier).not.toHaveBeenCalled();
  });

  it("is also off when the variable is missing", async () => {
    delete process.env.CONTENT_SOURCES_TOKENS_ENABLED;
    expect((await mint()).status).toBe(404);
    expect((await request(mount()).get("/content-sources/jwks")).status).toBe(404);
  });
});

describe("POST /content-sources/session", () => {
  it("refuses a caller who is not signed in", async () => {
    auth.mode = "none";
    expect((await mint()).status).toBe(401);
  });

  it("refuses an API key", async () => {
    auth.mode = "apiKey";
    const res = await mint();
    expect(res.status).toBe(403);
    expect(res.body.token).toBeUndefined();
  });

  it("gives a signed-in person a token that the public key verifies", async () => {
    const res = await mint();
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["expiresAt", "token"]);
    const parts = (res.body.token as string).split(".");
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(b64urlJson(parts[0])).toEqual({ alg: "ES256", typ: "JWT", kid: "route-kid" });
    const iat = Math.floor(NOW.getTime() / 1000);
    const claims = b64urlJson(parts[1]);
    expect(claims).toMatchObject({ iss: "lazyrelay", aud: "content-sources", sub: "user-1", acc: "acc-1", tier: "business", iat });
    expect(claims.exp - claims.iat).toBe(240);
    expect(claims.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.body.expiresAt).toBe(new Date((iat + 240) * 1000).toISOString());
    expect(tierMock.resolveTier).toHaveBeenCalledWith("acc-1");

    const key = createPublicKey({ key: good.publicJwk, format: "jwk" });
    const check = (h: string, p: string, s: string) => verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    expect(check(parts[0], parts[1], parts[2])).toBe(true);
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: "someone-else" })).toString("base64url");
    expect(check(parts[0], forged, parts[2])).toBe(false);
  });

  it("gives two requests different tokens", async () => {
    const a = (await mint()).body.token;
    const b = (await mint()).body.token;
    expect(a).not.toBe(b);
  });

  it("lets a team member use it", async () => {
    auth.role = "member";
    auth.accountId = "team-acc";
    const res = await mint();
    expect(res.status).toBe(200);
    expect(b64urlJson(res.body.token.split(".")[1]).acc).toBe("team-acc");
  });

  it("allows 10 a minute per person and refuses the 11th, without touching anyone else", async () => {
    const app = mount();
    for (let i = 0; i < 10; i++) expect((await mint(app)).status, `request ${i + 1}`).toBe(200);
    expect((await mint(app)).status).toBe(429);
    auth.userId = "user-2";
    expect((await mint(app)).status).toBe(200);
  });
});

describe("bad configuration answers 503 with nothing sensitive", () => {
  const cases: Array<[string, () => void]> = [
    ["missing private key", () => { delete process.env.CONTENT_SOURCES_SIGNING_KEY_JWK; }],
    ["malformed JSON", () => { process.env.CONTENT_SOURCES_SIGNING_KEY_JWK = `{"kty":"EC","d":"${good.privateJwk.d}`; }],
    ["public key carrying a private part", () => configure(good.privateJwk, good.privateJwk)],
    ["kid mismatch", () => configure(good.privateJwk, { ...good.publicJwk, kid: "other-kid" })],
    ["public key not matching the private key", () => configure(good.privateJwk, { ...other.publicJwk, kid: "route-kid" })],
    ["wrong curve", () => configure(wrongCurve.privateJwk, wrongCurve.publicJwk)],
  ];
  const secrets = () =>
    [good, other, wrongCurve].flatMap((p) => [p.privateJwk.d, p.privateJwk.x, p.privateJwk.y]).filter((v): v is string => typeof v === "string");

  for (const [name, arrange] of cases) {
    it(`${name}: both routes give 503 and a fixed body`, async () => {
      arrange();
      const post = await mint();
      const get = await request(mount()).get("/content-sources/jwks");
      for (const res of [post, get]) {
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: "Not available right now." });
        for (const s of secrets()) expect(res.text.includes(s)).toBe(false);
      }
      expect(logged.length).toBeGreaterThan(0);
      for (const line of logged) {
        for (const s of secrets()) expect(line.includes(s), line).toBe(false);
        expect(line).not.toMatch(/eyJ/);
      }
    });
  }

  it("logs a fixed tag and the error class only", async () => {
    delete process.env.CONTENT_SOURCES_SIGNING_KEY_JWK;
    await mint();
    expect(logged).toEqual(["content-sources token: not available SessionTokenConfigError"]);
  });
});

describe("GET /content-sources/jwks", () => {
  it("needs no sign-in and returns exactly one public key with a cache header", async () => {
    auth.mode = "none";
    const res = await request(mount()).get("/content-sources/jwks");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    expect(res.body.keys).toHaveLength(1);
    expect(res.body.keys[0].kid).toBe("route-kid");
    expect("d" in res.body.keys[0]).toBe(false);
    expect(res.text.includes(good.privateJwk.d as string)).toBe(false);
  });

  it("serves a key that verifies a freshly issued token", async () => {
    const token = (await mint()).body.token as string;
    const jwk = (await request(mount()).get("/content-sources/jwks")).body.keys[0];
    const [h, p, s] = token.split(".");
    const key = createPublicKey({ key: jwk, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))).toBe(true);
  });
});
