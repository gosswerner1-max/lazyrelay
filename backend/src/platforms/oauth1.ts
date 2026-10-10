// OAuth 1.0a request signing (RFC 5849, HMAC-SHA1), as X requires for a customer's own developer app ("bring your own
// key"). Pure functions, no network, no logging: the four secrets only ever pass through here as arguments.
//
// What goes into the signature, and what does not (this is where hand-rolled signers usually break):
//   - IN:  the oauth_* protocol parameters, every query-string parameter of the URL, and the fields of an
//          application/x-www-form-urlencoded body (pass them as `formParams`).
//   - OUT: JSON bodies (every X v2 endpoint), multipart bodies and raw octet bodies. They are simply not passed.
// Percent-encoding is RFC 3986: only A-Z a-z 0-9 - . _ ~ stay as they are, everything else (including ! * ' ( ))
// is %XX with upper-case hex, which is stricter than encodeURIComponent.

import { createHmac, randomBytes } from "node:crypto";

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/** RFC 3986 percent-encoding (RFC 5849 section 3.6). */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

type ParamList = Array<[string, string]>;

/** Scheme and host lower-cased, default port dropped, no query and no fragment (RFC 5849 section 3.4.1.2). */
export function baseStringUri(rawUrl: string): string {
  const u = new URL(rawUrl);
  const scheme = u.protocol.replace(":", "").toLowerCase();
  const host = u.hostname.toLowerCase();
  const defaultPort = scheme === "https" ? "443" : scheme === "http" ? "80" : "";
  const port = u.port && u.port !== defaultPort ? `:${u.port}` : "";
  return `${scheme}://${host}${port}${u.pathname}`;
}

/** Parameter normalisation (RFC 5849 section 3.4.1.3.2): encode names and values, sort by encoded name then encoded
 *  value, join as name=value with &. Pairs may repeat a name. */
export function normalizeParams(pairs: ParamList): string {
  return pairs
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export function signatureBaseString(method: string, rawUrl: string, pairs: ParamList): string {
  return [method.toUpperCase(), percentEncode(baseStringUri(rawUrl)), percentEncode(normalizeParams(pairs))].join("&");
}

export function hmacSha1Signature(baseString: string, consumerSecret: string, tokenSecret: string): string {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac("sha1", key).update(baseString).digest("base64");
}

export interface SignInput {
  method: string;
  /** Full URL. Its query string is part of the signature. */
  url: string;
  /** Fields of an application/x-www-form-urlencoded body, if the request has one. Never pass JSON or multipart content. */
  formParams?: Record<string, string> | ParamList;
  /** Fixed values, for tests only. */
  nonce?: string;
  timestamp?: string;
}

function toPairs(p: Record<string, string> | ParamList | undefined): ParamList {
  if (!p) return [];
  return Array.isArray(p) ? p : Object.entries(p);
}

/** The oauth_* parameters of a request, signature included, in the order the header is written. */
export function oauth1Params(creds: OAuth1Credentials, input: SignInput): Record<string, string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: input.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: input.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.token,
    oauth_version: "1.0",
  };
  const query: ParamList = [...new URL(input.url).searchParams.entries()];
  const all: ParamList = [...Object.entries(oauth), ...query, ...toPairs(input.formParams)];
  oauth.oauth_signature = hmacSha1Signature(signatureBaseString(input.method, input.url, all), creds.consumerSecret, creds.tokenSecret);
  return oauth;
}

/** The Authorization header value for a signed request. */
export function oauth1Header(creds: OAuth1Credentials, input: SignInput): string {
  const params = oauth1Params(creds, input);
  const parts = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(params[k])}"`);
  return `OAuth ${parts.join(", ")}`;
}
