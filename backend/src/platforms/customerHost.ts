import { isIP } from "node:net";
import { Agent, type Dispatcher } from "undici";
import { isSafeMediaUrl } from "../urlSafety.js";
import type { RequestInitWithDuplex } from "./streamUpload.js";

// Shared safety layer for adapters that talk to a server the CUSTOMER chose (a Mastodon
// instance, a third-party Bluesky PDS). Same approach lemmy.ts uses (lemmy.ts keeps its own
// private copy and is deliberately left alone): every request re-runs the SSRF guard, the
// connection is pinned to the addresses the guard just validated, redirects are never
// followed (a redirect could carry a token to another host), bodies are size capped and
// every call has a timeout. Nothing here ever puts a URL, header or token in an error.

export const REQUEST_TIMEOUT_MS = 30_000;
// A picture or video can take a while to upload; everything else is small.
export const UPLOAD_TIMEOUT_MS = 120_000;
// A customer-controlled server answering with more than this is refused unread.
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const BLOCKED_MESSAGE = "That server address is not allowed. It must be a public https address.";

/** A failure whose message is already safe and readable for the customer. */
export class CustomerHostError extends Error {
  constructor(message: string, readonly possiblySent = false) {
    super(message);
  }
}

/** Accepts "hachyderm.io" or "https://hachyderm.io[/]" and returns "https://hachyderm.io".
 *  Refuses anything that is not a bare https host name: other schemes, paths, queries,
 *  logins in the address, a port other than 443, or an IP address. `what` is the plain
 *  name used in messages, for example "Mastodon server". */
export function normalizeHostOrigin(
  input: string,
  what: string,
  example: string,
): { ok: true; origin: string; host: string } | { ok: false; error: string } {
  const raw = input.trim();
  if (!raw) return { ok: false, error: `Enter your ${what}, for example ${example}` };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: `That does not look like a ${what} address. Use something like ${example}` };
  }
  if (url.protocol !== "https:") return { ok: false, error: `The ${what} address must use https` };
  if (url.username || url.password) return { ok: false, error: `Do not put a username or password in the ${what} address` };
  if (url.port && url.port !== "443") return { ok: false, error: `The ${what} address cannot use a custom port` };
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    return { ok: false, error: `Enter only the ${what} name, for example ${example}, without a path` };
  }
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, "")) || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return { ok: false, error: `That does not look like a ${what} address. Use something like ${example}` };
  }
  return { ok: true, origin: `https://${host}`, host };
}

/** Same pinning trick as streamUpload.ts (its helper is private): the connection can only
 *  go to the addresses isSafeMediaUrl just validated, so DNS cannot answer differently
 *  between the check and the request. */
export function pinnedDispatcher(addresses: string[]): Dispatcher {
  const candidates = addresses
    .map((address) => ({ address, family: isIP(address) }))
    .filter((c): c is { address: string; family: 4 | 6 } => c.family === 4 || c.family === 6);
  return new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        if (candidates.length === 0) {
          callback(new Error("no valid pinned address"), "", 0);
          return;
        }
        if (options.all) callback(null, candidates);
        else callback(null, candidates[0].address, candidates[0].family);
      },
    },
  });
}

/** The one place a request to a customer-supplied server is made: guard, pin, no redirects,
 *  timeout. Throws CustomerHostError with a customer-safe message. */
export async function guardedFetch(url: string, init: RequestInitWithDuplex = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const parsed = new URL(url);
  const safety = await isSafeMediaUrl(parsed.origin);
  if (!safety.safe) {
    // A DNS lookup that failed (a hiccup, or a typo) is not the same as a blocked address.
    if (safety.reason === "could not resolve") {
      throw new CustomerHostError(`Could not reach ${parsed.hostname}. Check the address and try again later.`);
    }
    throw new CustomerHostError(BLOCKED_MESSAGE);
  }
  try {
    return await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: pinnedDispatcher(safety.addresses),
    } as RequestInitWithDuplex);
  } catch {
    // Deliberately no err.message: it can echo the URL or headers.
    throw new CustomerHostError(`Could not reach ${parsed.hostname}. Check the server address and try again later.`, true);
  }
}

/** Reads a JSON body but stops (and returns null) once it passes MAX_RESPONSE_BYTES, so a
 *  hostile or broken server cannot make us hold an unbounded answer in memory. */
export async function readJsonCapped(res: Response): Promise<unknown> {
  if (!res.body) return null;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await res.body.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
