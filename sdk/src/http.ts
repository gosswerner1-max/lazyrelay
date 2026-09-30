import { LazyRelayError } from "./errors.js";
import { DEFAULT_BASE_URL, VERSION } from "./version.js";

export interface LazyRelayOptions {
  /** A lzr_live_ API key. Falls back to the LAZYRELAY_API_KEY environment variable. */
  apiKey?: string;
  /** Defaults to the production API, https://lazyrelaylazyrelay-backend.onrender.com/api */
  baseUrl?: string;
  /** A fetch implementation to use instead of the global one (tests, proxies, custom agents). */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as multipart. Mutually exclusive with body. */
  form?: FormData;
  timeoutMs?: number;
}

const MAX_RETRY_WAIT_MS = 10_000;
const DEFAULT_RETRY_WAIT_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryDelayMs(res: Response): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_WAIT_MS);
  }
  return DEFAULT_RETRY_WAIT_MS;
}

/** The one place that talks HTTP. Every resource method goes through request(). */
export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;

  constructor(options: LazyRelayOptions = {}) {
    const envKey = typeof process !== "undefined" ? process.env?.LAZYRELAY_API_KEY : undefined;
    const apiKey = (options.apiKey ?? envKey ?? "").trim();
    if (!apiKey) {
      throw LazyRelayError.local("auth", "No API key. Pass { apiKey } or set the LAZYRELAY_API_KEY environment variable. Create a key in the LazyRelay dashboard under Settings, More, API Keys.");
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    let url = `${this.baseUrl}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) params.set(key, String(value));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  /**
   * Idempotent GETs are retried once on a 5xx, a 429 (honouring Retry-After) or a network
   * failure. POST, PATCH and DELETE are never retried: a retried post could be created twice.
   */
  async request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": `lazyrelay-sdk-node/${VERSION}`,
    };
    let body: string | FormData | undefined;
    if (options.form) {
      body = options.form; // fetch sets the multipart Content-Type and boundary itself
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const maxAttempts = method === "GET" ? 2 : 1;

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        const timedOut = name === "TimeoutError" || name === "AbortError";
        if (attempt < maxAttempts) {
          await sleep(DEFAULT_RETRY_WAIT_MS);
          continue;
        }
        const cause = err instanceof Error ? (err.cause as { code?: string } | undefined)?.code : undefined;
        const detail = err instanceof Error ? err.message : String(err);
        throw LazyRelayError.local("unknown", timedOut ? `The request timed out after ${timeoutMs} ms.` : `Could not reach LazyRelay${cause ? ` (${cause})` : ""}: ${detail}`, true);
      }

      if (res.ok) return (await readSuccess(res)) as T;

      if (attempt < maxAttempts && (res.status === 429 || res.status >= 500)) {
        const wait = retryDelayMs(res);
        await res.arrayBuffer().catch(() => undefined); // free the connection before retrying
        await sleep(wait);
        continue;
      }
      throw await readError(res);
    }
  }
}

async function readSuccess(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw LazyRelayError.local("unknown", `LazyRelay answered with something that is not JSON (HTTP ${res.status}). Check baseUrl.`);
  }
}

async function readError(res: Response): Promise<LazyRelayError> {
  const text = await res.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  let message = `LazyRelay API error (HTTP ${res.status})`;
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const err = (parsed as { error: unknown }).error;
    message = typeof err === "string" ? err : JSON.stringify(err);
  }
  return LazyRelayError.fromResponse(res.status, message, parsed);
}
