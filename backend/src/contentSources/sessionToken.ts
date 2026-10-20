// Short-lived signed session tokens for a companion service. LazyRelay signs; the companion service verifies with the
// PUBLIC key only (served by getPublicJwks). ES256 through node:crypto, no extra dependency.
//
// Fails closed: any configuration problem throws SessionTokenConfigError and nothing is issued or served. The error
// messages are fixed strings. They never include the key, any part of it, or the text of an underlying parser error.

import { createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject, type webcrypto } from "node:crypto";
import type { Tier } from "../tier.js";

type JsonWebKey = webcrypto.JsonWebKey;

/** The companion service refuses anything longer than 300 seconds. */
export const SESSION_TOKEN_LIFETIME_SECONDS = 240;
const ISSUER = "lazyrelay";
const AUDIENCE = "content-sources";

export class SessionTokenConfigError extends Error {
  constructor(public readonly code: string) {
    super(`Content sources token configuration is invalid (${code}).`);
    this.name = "SessionTokenConfigError";
  }
}

export interface PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
  alg: "ES256";
  use: "sig";
}

/** Read at call time, so the switch and the keys can change without a restart of the module. */
export function isEnabled(): boolean {
  return process.env.CONTENT_SOURCES_TOKENS_ENABLED === "true";
}

function parseJwk(raw: string | undefined, missingCode: string, badCode: string): JsonWebKey & { kid?: unknown } {
  if (!raw) throw new SessionTokenConfigError(missingCode);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionTokenConfigError(badCode);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new SessionTokenConfigError(badCode);
  return parsed as JsonWebKey & { kid?: unknown };
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function checkEcP256(jwk: JsonWebKey & { kid?: unknown }, code: string): void {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw new SessionTokenConfigError(code);
  if (!isNonEmptyString(jwk.x) || !isNonEmptyString(jwk.y) || !isNonEmptyString(jwk.kid)) throw new SessionTokenConfigError(code);
  if (jwk.alg !== undefined && jwk.alg !== "ES256") throw new SessionTokenConfigError(code);
  if (jwk.use !== undefined && jwk.use !== "sig") throw new SessionTokenConfigError(code);
}

interface SigningConfig {
  privateKey: KeyObject;
  publicJwk: PublicJwk;
}

function pairSignsAndVerifies(privateKey: KeyObject, publicKey: KeyObject): boolean {
  try {
    const probe = Buffer.from(randomUUID());
    const signature = sign("sha256", probe, { key: privateKey, dsaEncoding: "ieee-p1363" });
    return verify("sha256", probe, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return false;
  }
}

function loadConfig(): SigningConfig {
  const priv = parseJwk(process.env.CONTENT_SOURCES_SIGNING_KEY_JWK, "private_key_missing", "private_key_unreadable");
  const pub = parseJwk(process.env.CONTENT_SOURCES_PUBLIC_JWK, "public_key_missing", "public_key_unreadable");

  checkEcP256(priv, "private_key_invalid");
  if (!isNonEmptyString(priv.d)) throw new SessionTokenConfigError("private_key_invalid");
  checkEcP256(pub, "public_key_invalid");
  if ("d" in pub) throw new SessionTokenConfigError("public_key_has_private_part");
  if (priv.kid !== pub.kid) throw new SessionTokenConfigError("kid_mismatch");

  let privateKey: KeyObject;
  let publicKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: priv, format: "jwk" });
    publicKey = createPublicKey({ key: pub, format: "jwk" });
  } catch {
    throw new SessionTokenConfigError("key_import_failed");
  }
  // Node does not check that a private JWK's x and y belong to its d, so the pair is proven by signing a probe with
  // the private key and verifying it with the published one.
  if (priv.x !== pub.x || priv.y !== pub.y || !pairSignsAndVerifies(privateKey, publicKey)) {
    throw new SessionTokenConfigError("key_pair_mismatch");
  }
  return { privateKey, publicJwk: { kty: "EC", crv: "P-256", x: pub.x as string, y: pub.y as string, kid: pub.kid as string, alg: "ES256", use: "sig" } };
}

const b64url = (value: object) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/**
 * `server: true` adds the boolean claim srv: true: a token LazyRelay's own backend minted for a server to server call (the competitor
 * teardown). It is never sent to a browser. `ttlSeconds` shortens the lifetime (whole seconds, 1 up to the normal limit).
 */
export function issueSessionToken(input: { userId: string; accountId: string; tier: Tier; now: Date; server?: boolean; ttlSeconds?: number }): {
  token: string;
  expiresAt: Date;
  tokenId: string;
} {
  const { privateKey, publicJwk } = loadConfig();
  const iat = Math.floor(input.now.getTime() / 1000);
  const ttl = input.ttlSeconds ?? SESSION_TOKEN_LIFETIME_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > SESSION_TOKEN_LIFETIME_SECONDS) throw new SessionTokenConfigError("ttl_invalid");
  const exp = iat + ttl;
  const tokenId = randomUUID();
  const header = { alg: "ES256", typ: "JWT", kid: publicJwk.kid };
  const claims = { iss: ISSUER, aud: AUDIENCE, sub: input.userId, acc: input.accountId, tier: input.tier, ...(input.server === true ? { srv: true } : {}), iat, exp, jti: tokenId };
  const signingInput = `${b64url(header)}.${b64url(claims)}`;
  let signature: Buffer;
  try {
    signature = sign("sha256", Buffer.from(signingInput, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" });
  } catch {
    throw new SessionTokenConfigError("signing_failed");
  }
  return { token: `${signingInput}.${signature.toString("base64url")}`, expiresAt: new Date(exp * 1000), tokenId };
}

/** The public key set a verifier fetches. Rebuilt from fixed fields, so nothing extra in the configured value is echoed. */
export function getPublicJwks(): { keys: PublicJwk[] } {
  return { keys: [loadConfig().publicJwk] };
}
