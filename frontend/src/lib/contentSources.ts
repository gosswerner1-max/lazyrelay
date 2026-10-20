// The thin service plumbing shared by the competitor box and the status panel. It holds the one place that knows what a
// private or local address looks like, the plain-words error the session token raises, the short lived session token, and the
// service client, which now only asks whether the service is up. Nothing here reads or rewrites a page: that is the companion
// service's work. Until the service has an address (VITE_CONTENT_SOURCES_API_URL) the client has no readiness check, so the
// status panel says Unknown, and no network call is made.

export const URL_MAX_LENGTH = 2048;

/** What the status panel needs from the companion service. */
export interface ContentSourcesClient {
  /**
   * Is the service up? Needs no sign in. True or false when the service really answered or did not; null when it cannot be
   * told (the browser itself is offline). Optional: the Not connected client has none, and the status panel then shows Unknown.
   */
  ready?(signal?: AbortSignal): Promise<boolean | null>;
}

function ipv4Blocked(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // shared address space
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function ipv6Blocked(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(h)) return true; // fc00::/7 unique local
  // An IPv4 address written inside an IPv6 one. The address parser rewrites ::ffff:1.2.3.4 as ::ffff:102:304.
  const embedded = h.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (embedded) {
    const hi = parseInt(embedded[1], 16);
    return ipv4Blocked(hi >> 8, hi & 255);
  }
  const dotted = h.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) return ipv4Blocked(Number(dotted[1]), Number(dotted[2]));
  return false;
}

/** True for localhost and for private, loopback and link-local address literals. */
export function hostIsInternal(hostname: string): boolean {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.startsWith("[") && host.endsWith("]")) return ipv6Blocked(host.slice(1, -1));
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) return ipv4Blocked(Number(v4[1]), Number(v4[2]));
  return false;
}

// ---------- Plain words for errors ----------
// Only a code travels; every sentence the customer sees is written here, so nothing the service (or anything in between) says
// can reach the screen, and no message can carry a token.

const MESSAGES = {
  not_connected: "Not connected yet. Content Sources is not switched on for your account.",
  sign_in: "Please sign in again to use Content Sources.",
  try_later: "Content Sources is busy right now. Please try again in a moment.",
  network: "We could not reach Content Sources. Check your connection and try again.",
  bad_response: "Content Sources sent an answer we could not read. Please try again in a moment.",
  internal: "Something went wrong on our side. Please try again in a moment.",
} as const;

export type ContentSourcesErrorCode = keyof typeof MESSAGES;

/** The only error the session token raises. It carries a stable code and a plain sentence, never a token or service text. */
export class ContentSourcesError extends Error {
  readonly code: ContentSourcesErrorCode;

  constructor(code: ContentSourcesErrorCode) {
    super(MESSAGES[code]);
    this.name = "ContentSourcesError";
    this.code = code;
  }
}

const READY_TIMEOUT_MS = 5000;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const bad = () => new ContentSourcesError("bad_response");

// ---------- The session token ----------
// The companion service does not know LazyRelay sign ins. The LazyRelay API hands out a short lived token for it. The token is
// kept in memory only, reused until 30 seconds before it expires, and one request is shared between calls made at once.
// It is never written to storage and never logged.

export interface SessionGrant {
  token: string;
  expiresAt: string;
}

export interface SessionTokenProvider {
  getToken(): Promise<string>;
  /** Forget the kept token, so the next call asks for a new one. */
  invalidate(): void;
}

const EXPIRY_MARGIN_MS = 30_000;

function sessionErrorFor(err: unknown): ContentSourcesError {
  if (err instanceof ContentSourcesError) return err;
  const status = err instanceof Error ? (err as { status?: unknown }).status : undefined;
  if (status === 404) return new ContentSourcesError("not_connected"); // the feature is switched off for now
  if (status === 401) return new ContentSourcesError("sign_in");
  if (status === 503) return new ContentSourcesError("try_later");
  if (err instanceof Error && err.message === "Not signed in") return new ContentSourcesError("sign_in");
  console.error(err); // anything else keeps its raw error in the console; the customer gets the plain sentence
  return new ContentSourcesError(typeof status === "number" ? "internal" : "network");
}

export function createSessionTokenProvider(opts: { fetchSession: () => Promise<SessionGrant>; now?: () => number }): SessionTokenProvider {
  const now = opts.now ?? Date.now;
  let kept: { token: string; expiresAtMs: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function ask(): Promise<string> {
    let grant: unknown;
    try {
      grant = await opts.fetchSession();
    } catch (err) {
      throw sessionErrorFor(err);
    }
    if (!isObject(grant) || !isString(grant.token) || grant.token === "" || !isString(grant.expiresAt)) throw bad();
    const expiresAtMs = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresAtMs)) throw bad();
    kept = expiresAtMs - EXPIRY_MARGIN_MS > now() ? { token: grant.token, expiresAtMs } : null; // too close to the end to keep
    return grant.token;
  }

  return {
    async getToken() {
      if (kept && now() < kept.expiresAtMs - EXPIRY_MARGIN_MS) return kept.token;
      inFlight ??= ask().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    invalidate() {
      kept = null;
    },
  };
}

// ---------- The service client ----------

function checkedBase(raw: string): string {
  const text = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("The Content Sources address is not a web address.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("The Content Sources address must be a plain https address.");
  }
  return text;
}

/** The client for the companion service. It only asks whether the service is up, with no token and no cookies. */
export function createServiceClient(opts: { baseUrl: string; fetchImpl?: typeof fetch }): ContentSourcesClient {
  const base = checkedBase(opts.baseUrl);
  const doFetch: typeof fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    async ready(signal) {
      const ctl = new AbortController();
      const stop = () => ctl.abort();
      const timer = setTimeout(stop, READY_TIMEOUT_MS);
      signal?.addEventListener("abort", stop);
      try {
        const res = await doFetch(`${base}/v1/ready`, { method: "GET", headers: { Accept: "application/json" }, credentials: "omit", cache: "no-store", signal: ctl.signal });
        return res.ok;
      } catch (err) {
        if (ctl.signal.aborted) return false; // a timeout or a stop is expected
        console.error(err); // anything else stays visible
        return typeof navigator !== "undefined" && navigator.onLine === false ? null : false; // offline says nothing about the service
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
      }
    },
  };
}

/** The client used when the service has no address (or an unusable one): no readiness check, so the panel says Unknown, and no network call. */
export function createNotConnectedClient(): ContentSourcesClient {
  return {};
}
