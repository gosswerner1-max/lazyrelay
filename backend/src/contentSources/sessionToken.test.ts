// Session tokens for a companion service: issuing, the public key set, and failing closed on any bad configuration.
// Every key here is generated at run time and thrown away; no key material lives in this repository.

import { describe, it, expect, afterEach } from "vitest";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";

type JsonWebKey = import("node:crypto").webcrypto.JsonWebKey;
import { issueSessionToken, getPublicJwks, isEnabled, SessionTokenConfigError, SESSION_TOKEN_LIFETIME_SECONDS } from "./sessionToken.js";

const ENV_NAMES = ["CONTENT_SOURCES_SIGNING_KEY_JWK", "CONTENT_SOURCES_PUBLIC_JWK", "CONTENT_SOURCES_TOKENS_ENABLED"] as const;
const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
afterEach(() => {
  for (const n of ENV_NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

function makePair(kid = "test-kid", namedCurve: "P-256" | "P-384" = "P-256") {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve });
  const priv = privateKey.export({ format: "jwk" }) as JsonWebKey;
  const pub = createPublicKey(privateKey).export({ format: "jwk" }) as JsonWebKey;
  return {
    privateJwk: { ...priv, kid, alg: "ES256", use: "sig" },
    publicJwk: { ...pub, kid, alg: "ES256", use: "sig" },
  };
}

function configure(privateJwk: unknown, publicJwk: unknown) {
  process.env.CONTENT_SOURCES_SIGNING_KEY_JWK = JSON.stringify(privateJwk);
  process.env.CONTENT_SOURCES_PUBLIC_JWK = JSON.stringify(publicJwk);
}

const NOW = new Date("2026-10-19T10:00:00.000Z");
const input = { userId: "user-1", accountId: "acc-1", tier: "pro" as const, now: NOW };
const b64urlJson = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

describe("isEnabled", () => {
  it("is true only for the exact string true", () => {
    for (const v of ["false", "TRUE", "True", "1", "yes", "on", "", " true", "true "]) {
      process.env.CONTENT_SOURCES_TOKENS_ENABLED = v;
      expect(isEnabled(), JSON.stringify(v)).toBe(false);
    }
    delete process.env.CONTENT_SOURCES_TOKENS_ENABLED;
    expect(isEnabled()).toBe(false);
    process.env.CONTENT_SOURCES_TOKENS_ENABLED = "true";
    expect(isEnabled()).toBe(true);
  });
});

describe("issueSessionToken", () => {
  it("returns a three part token with the agreed header and claims", () => {
    const { privateJwk, publicJwk } = makePair();
    configure(privateJwk, publicJwk);
    const out = issueSessionToken(input);
    const parts = out.token.split(".");
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(b64urlJson(parts[0])).toEqual({ alg: "ES256", typ: "JWT", kid: "test-kid" });
    const iat = Math.floor(NOW.getTime() / 1000);
    const claims = b64urlJson(parts[1]);
    expect(claims).toEqual({
      iss: "lazyrelay",
      aud: "content-sources",
      sub: "user-1",
      acc: "acc-1",
      tier: "pro",
      iat,
      exp: iat + 240,
      jti: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    });
    expect(SESSION_TOKEN_LIFETIME_SECONDS).toBe(240);
    expect(out.tokenId).toBe(claims.jti);
    expect(out.expiresAt.toISOString()).toBe(new Date((iat + 240) * 1000).toISOString());
  });

  it("uses whole seconds from the injected clock", () => {
    const { privateJwk, publicJwk } = makePair();
    configure(privateJwk, publicJwk);
    const out = issueSessionToken({ ...input, now: new Date("2026-10-19T10:00:00.999Z") });
    const claims = b64urlJson(out.token.split(".")[1]);
    expect(claims.iat).toBe(Math.floor(new Date("2026-10-19T10:00:00Z").getTime() / 1000));
  });

  it("signs so the public key verifies it, and a tampered payload does not", () => {
    const { privateJwk, publicJwk } = makePair();
    configure(privateJwk, publicJwk);
    const [h, p, s] = issueSessionToken(input).token.split(".");
    const key = createPublicKey({ key: publicJwk, format: "jwk" });
    const check = (hh: string, pp: string, ss: string) => verify("sha256", Buffer.from(`${hh}.${pp}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(ss, "base64url"));
    expect(Buffer.from(s, "base64url")).toHaveLength(64);
    expect(check(h, p, s)).toBe(true);
    const forged = Buffer.from(JSON.stringify({ ...b64urlJson(p), tier: "agency_plus" })).toString("base64url");
    expect(check(h, forged, s)).toBe(false);
  });

  it("gives every token its own id", () => {
    const { privateJwk, publicJwk } = makePair();
    configure(privateJwk, publicJwk);
    const a = issueSessionToken(input);
    const b = issueSessionToken(input);
    expect(a.tokenId).not.toBe(b.tokenId);
    expect(a.token).not.toBe(b.token);
  });
});

describe("getPublicJwks", () => {
  it("returns exactly the public key, with no private member", () => {
    const { privateJwk, publicJwk } = makePair("kid-9");
    configure(privateJwk, publicJwk);
    const set = getPublicJwks();
    expect(set.keys).toHaveLength(1);
    expect(set.keys[0]).toEqual({ kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y, kid: "kid-9", alg: "ES256", use: "sig" });
    expect("d" in set.keys[0]).toBe(false);
  });

  it("verifies a token issued by the same configuration", () => {
    const { privateJwk, publicJwk } = makePair();
    configure(privateJwk, publicJwk);
    const [h, p, s] = issueSessionToken(input).token.split(".");
    const key = createPublicKey({ key: getPublicJwks().keys[0] as JsonWebKey, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))).toBe(true);
  });
});

describe("bad configuration fails closed", () => {
  const a = makePair("same");
  const b = makePair("same");
  const cases: Array<[string, () => void]> = [
    ["missing private key", () => { delete process.env.CONTENT_SOURCES_SIGNING_KEY_JWK; process.env.CONTENT_SOURCES_PUBLIC_JWK = JSON.stringify(a.publicJwk); }],
    ["missing public key", () => { process.env.CONTENT_SOURCES_SIGNING_KEY_JWK = JSON.stringify(a.privateJwk); delete process.env.CONTENT_SOURCES_PUBLIC_JWK; }],
    ["malformed private JSON", () => { process.env.CONTENT_SOURCES_SIGNING_KEY_JWK = `{${a.privateJwk.d}`; process.env.CONTENT_SOURCES_PUBLIC_JWK = JSON.stringify(a.publicJwk); }],
    ["malformed public JSON", () => { process.env.CONTENT_SOURCES_SIGNING_KEY_JWK = JSON.stringify(a.privateJwk); process.env.CONTENT_SOURCES_PUBLIC_JWK = "not json"; }],
    ["private key without d", () => configure({ ...a.publicJwk }, a.publicJwk)],
    ["public key carrying d", () => configure(a.privateJwk, a.privateJwk)],
    ["kid mismatch", () => configure(a.privateJwk, { ...a.publicJwk, kid: "other" })],
    ["public key of a different pair", () => configure(a.privateJwk, b.publicJwk)],
    ["private x y not matching its d", () => configure({ ...a.privateJwk, x: b.privateJwk.x, y: b.privateJwk.y }, { ...a.publicJwk, x: b.privateJwk.x, y: b.privateJwk.y })],
    ["wrong curve", () => { const p384 = makePair("same", "P-384"); configure(p384.privateJwk, p384.publicJwk); }],
    ["wrong key type", () => configure({ kty: "oct", k: "AAAA", kid: "same" }, { kty: "oct", k: "AAAA", kid: "same" })],
    ["no kid", () => { const { kid: _k, ...priv } = a.privateJwk; const { kid: _j, ...pub } = a.publicJwk; configure(priv, pub); }],
    ["wrong alg", () => configure({ ...a.privateJwk, alg: "HS256" }, { ...a.publicJwk, alg: "HS256" })],
    ["JSON that is not an object", () => { process.env.CONTENT_SOURCES_SIGNING_KEY_JWK = "[]"; process.env.CONTENT_SOURCES_PUBLIC_JWK = JSON.stringify(a.publicJwk); }],
  ];

  for (const [name, arrange] of cases) {
    it(`${name}: both functions throw SessionTokenConfigError without key material`, () => {
      arrange();
      for (const fn of [() => issueSessionToken(input), () => getPublicJwks()]) {
        let caught: unknown;
        try {
          fn();
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(SessionTokenConfigError);
        const text = `${(caught as Error).name} ${(caught as Error).message} ${(caught as Error).stack}`;
        for (const secret of [a.privateJwk.d, a.privateJwk.x, a.privateJwk.y, b.privateJwk.d, b.privateJwk.x, b.privateJwk.y]) {
          expect(text.includes(secret as string)).toBe(false);
        }
      }
    });
  }
});
