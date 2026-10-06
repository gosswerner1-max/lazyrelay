import { Agent } from "undici";
import { isTransientStatus } from "./upstream.js";

// One choke point for every request the Supabase clients make (REST, RPC, auth,
// storage): supabase-js hands this single function to all of them.
//
// What it adds over the default fetch:
//  - a hard per-attempt timeout, so a hung gateway cannot hold a request open
//    for undici's default five minutes;
//  - a process-wide cap on requests in flight, with a bounded wait for a slot,
//    so a burst (the 30 s scheduler and webhook ticks) cannot open an
//    unbounded number of new sockets at the same instant;
//  - a shared keep-alive connection pool, so a 30 s tick reuses sockets
//    instead of paying a fresh TLS handshake per request;
//  - retry with full-jitter exponential backoff for GET and HEAD only, on the
//    gateway failures that mean "try again" (502, 503, 504, 520 to 530 which
//    includes 522 connection timed out) and on network errors.
// Writes and RPCs are never retried here: a lost response does not say whether
// the write happened, so only the caller can decide whether repeating it is safe.

export interface ResilientFetchOptions {
  /** Per-attempt ceiling for REST, RPC and auth calls. */
  timeoutMs: number;
  /** Per-attempt ceiling for storage calls, which carry whole media files. */
  storageTimeoutMs: number;
  /** Most requests allowed on the wire at once. */
  maxInFlight: number;
  /** Longest a request waits for a free slot before failing as a timeout. */
  queueTimeoutMs: number;
  /** Total attempts for GET and HEAD (1 = no retry). */
  attempts: number;
  baseDelayMs: number;
  capDelayMs: number;
  /** Injection points for tests. */
  baseFetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

// Worst case for a GET: 3 attempts x 8 s plus two short backoffs, which stays
// under the 30 s billing lock TTL (billing/locks.ts), so a hung read cannot
// outlive the lock that protects a checkout.
export const DEFAULT_RESILIENCE: Omit<ResilientFetchOptions, "baseFetch" | "sleep" | "random"> = {
  timeoutMs: 8_000,
  storageTimeoutMs: 120_000,
  maxInFlight: 10,
  queueTimeoutMs: 10_000,
  attempts: 3,
  baseDelayMs: 250,
  capDelayMs: 2_000,
};

class Semaphore {
  private free: number;
  private readonly waiters: Array<() => void> = [];
  constructor(max: number) {
    this.free = max;
  }

  async acquire(timeoutMs: number): Promise<() => void> {
    if (this.free > 0) {
      this.free -= 1;
      return () => this.release();
    }
    return new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`Supabase request timed out waiting for a free connection slot (${timeoutMs} ms)`));
      }, timeoutMs);
      const grant = () => {
        clearTimeout(timer);
        resolve(() => this.release());
      };
      this.waiters.push(grant);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free += 1;
  }
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function methodOf(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === "object" && !(input instanceof URL) && input.method) return input.method.toUpperCase();
  return "GET";
}

export function createResilientFetch(overrides: Partial<ResilientFetchOptions> = {}): typeof fetch {
  const o: ResilientFetchOptions = { ...DEFAULT_RESILIENCE, ...overrides };
  const sem = new Semaphore(o.maxInFlight);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = o.random ?? Math.random;
  // Only built for the real fetch: an injected baseFetch (tests) gets none.
  const dispatcher = o.baseFetch
    ? undefined
    : new Agent({ connections: 16, keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, connect: { timeout: 5_000 } });
  const base: typeof fetch = o.baseFetch ?? ((input, init) => fetch(input, { ...init, dispatcher } as RequestInit));

  return async (input, init) => {
    const url = urlOf(input);
    const method = methodOf(input, init);
    const isStorage = url.includes("/storage/v1/");
    const canRetry = (method === "GET" || method === "HEAD") && !isStorage;
    const maxAttempts = canRetry ? Math.max(1, o.attempts) : 1;
    const timeoutMs = isStorage ? o.storageTimeoutMs : o.timeoutMs;

    for (let attempt = 1; ; attempt++) {
      // Storage transfers can run for minutes, so they do not hold a slot.
      const release = isStorage ? () => {} : await sem.acquire(o.queueTimeoutMs).catch((err: Error) => {
        // Waiting too long is a timeout like any other: retryable for a read.
        if (attempt >= maxAttempts) throw err;
        return null;
      });
      let failure: string | null = null;
      if (release) {
        try {
          const timeout = AbortSignal.timeout(timeoutMs);
          const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
          const res = await base(input, { ...init, signal });
          if (!isTransientStatus(res.status) || attempt >= maxAttempts) return res;
          failure = `status ${res.status}`;
          await res.body?.cancel().catch(() => {});
        } catch (err) {
          // The caller cancelled it on purpose: never retry that.
          if (init?.signal?.aborted || attempt >= maxAttempts) throw err;
          failure = err instanceof Error ? err.message : String(err);
        } finally {
          release();
        }
      } else {
        failure = "no free connection slot";
      }
      const delay = Math.floor(random() * Math.min(o.capDelayMs, o.baseDelayMs * 2 ** (attempt - 1)));
      let path = url;
      try {
        path = new URL(url).pathname;
      } catch {
        // keep the raw string
      }
      console.warn(`[supabase] ${method} ${path} attempt ${attempt}/${maxAttempts} failed (${failure.slice(0, 120)}); retrying in ${delay} ms`);
      await sleep(delay);
    }
  };
}
