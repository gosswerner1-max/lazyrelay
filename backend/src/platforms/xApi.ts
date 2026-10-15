// Signed calls to X's API for a customer's own app, shared by the adapter, the media uploader, the keys route and the
// live probe script. Every request is signed here from the parsed bundle (oauth1.ts); nothing is cached.

import { oauth1Header, type OAuth1Credentials } from "./oauth1.js";
import { bundleSecrets, type XByokBundle } from "./xByok.js";

export const X_API_BASE = "https://api.x.com";

export interface XRequest {
  method: "GET" | "POST" | "DELETE";
  url: string;
  /** JSON body (X v2 endpoints). Not part of the signature. */
  json?: unknown;
  /** Multipart body (media APPEND). Not part of the signature. */
  multipart?: FormData;
}
export type XSignedFetch = (req: XRequest) => Promise<Response>;

export function credentialsOf(bundle: XByokBundle): OAuth1Credentials {
  return { consumerKey: bundle.apiKey, consumerSecret: bundle.apiSecret, token: bundle.accessToken, tokenSecret: bundle.accessTokenSecret };
}

/** A fetch that signs each request with the bundle's OAuth 1.0a keys. */
export function createXSignedFetch(bundle: XByokBundle, fetchImpl: typeof fetch = (...a) => fetch(...a)): XSignedFetch {
  const creds = credentialsOf(bundle);
  return (req) => {
    const headers: Record<string, string> = { Authorization: oauth1Header(creds, { method: req.method, url: req.url }) };
    let body: BodyInit | undefined;
    if (req.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.json);
    } else if (req.multipart) {
      body = req.multipart; // fetch sets the multipart boundary itself
    }
    return fetchImpl(req.url, { method: req.method, headers, ...(body !== undefined ? { body } : {}) });
  };
}

export interface XErrorInfo {
  title: string | null;
  type: string | null;
  detail: string | null;
}

interface XErrorBody {
  title?: unknown;
  type?: unknown;
  detail?: unknown;
  reason?: unknown;
  error?: unknown;
  errors?: Array<{ message?: unknown; code?: unknown }>;
}

const MAX_FIELD = 240;
const asText = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_FIELD) : null);

/** Pulls X's own error fields (title, type, detail) out of a response body. Handles the v2 problem format and the
 *  older {errors:[{code,message}]} format. */
export function readXError(body: unknown): XErrorInfo {
  const b = (body && typeof body === "object" ? body : {}) as XErrorBody;
  const first = Array.isArray(b.errors) ? b.errors[0] : undefined;
  return {
    title: asText(b.title) ?? (first?.code !== undefined ? `code ${String(first.code).slice(0, 12)}` : null),
    type: asText(b.type),
    detail: asText(b.detail) ?? asText(first?.message) ?? asText(b.reason) ?? asText(b.error),
  };
}

/** Removes any of the customer's secrets from a string, defence in depth: X does not echo them, but nothing may
 *  ever carry one. */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 6) out = out.split(s).join("[removed]");
  return out;
}

/** Reads a response body as JSON without ever throwing. */
export async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** One compact line for a failed X call, used as the adapter's error text. It carries only X's status and its own
 *  error fields (never a request header, the keys, or the whole body), which is what postErrors.ts classifies. */
export function describeXFailure(res: Response, body: unknown, bundle: XByokBundle): string {
  const e = readXError(body);
  const reset = res.headers?.get?.("x-rate-limit-reset") ?? null;
  const parts = [
    `x_api_error status=${res.status}`,
    e.type ? `type=${e.type}` : null,
    e.title ? `title="${e.title}"` : null,
    e.detail ? `detail="${e.detail}"` : null,
    reset && /^\d{9,11}$/.test(reset) ? `reset=${reset}` : null,
  ].filter(Boolean);
  return scrubSecrets(parts.join(" "), bundleSecrets(bundle));
}
