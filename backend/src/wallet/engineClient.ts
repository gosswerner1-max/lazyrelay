import { issueSessionToken } from "../contentSources/sessionToken.js";
import type { Tier } from "../tier.js";

/**
 * Server to server client for the competitor engine (the content sources service). The backend mints a short lived ES256 token itself
 * (the same code that signs the dashboard's content sources token) carrying the boolean claim srv: true, so the engine can tell a call
 * the backend orchestrated and charged for from a browser call. The token lives only inside this call: it is never returned, stored or
 * logged. Errors are raised exactly as the engine gave them (status, code, message); nothing falls back to a default.
 */
export const ENGINE_TOKEN_TTL_SECONDS = 120;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface EngineIdentity {
  userId: string;
  accountId: string;
  tier: Tier;
}

export class EngineError extends Error {
  readonly status: number | null;
  readonly code: string;
  constructor(message: string, info: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = "EngineError";
    this.status = info.status ?? null;
    this.code = info.code ?? "engine_error";
  }
}

export interface EngineClient {
  analyze(identity: EngineIdentity, input: string): Promise<unknown>;
  blueprint(identity: EngineIdentity, input: string): Promise<unknown>;
}

export interface EngineClientOptions {
  /** Defaults to CONTENT_SOURCES_API_URL, read at call time. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export function createEngineClient(options: EngineClientOptions = {}): EngineClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call(path: "/v1/analyze" | "/v1/blueprint", identity: EngineIdentity, input: string): Promise<unknown> {
    const base = (options.baseUrl ?? process.env.CONTENT_SOURCES_API_URL ?? "").trim().replace(/\/+$/, "");
    if (base === "") throw new EngineError("The engine address is not set (CONTENT_SOURCES_API_URL).", { code: "not_configured" });

    // A bad key configuration throws SessionTokenConfigError here, unchanged.
    const { token } = issueSessionToken({ ...identity, now: now(), server: true, ttlSeconds: ENGINE_TOKEN_TTL_SECONDS });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetchImpl(`${base}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ input }),
          signal: controller.signal,
        });
      } catch (cause) {
        const aborted = cause instanceof Error && cause.name === "AbortError";
        throw new EngineError(aborted ? `The engine did not answer within ${timeoutMs} ms.` : "The engine could not be reached.", { code: aborted ? "timeout" : "unreachable", cause });
      }
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        if (res.ok) throw new EngineError("The engine answered with something that is not JSON.", { status: res.status, code: "bad_answer" });
      }
      if (!res.ok) {
        const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
        const code = typeof obj.code === "string" ? obj.code : "engine_error";
        const message = typeof obj.message === "string" ? obj.message : text.slice(0, 300);
        throw new EngineError(`Engine ${path} answered ${res.status} ${code}: ${message}`, { status: res.status, code });
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    analyze: (identity, input) => call("/v1/analyze", identity, input),
    blueprint: (identity, input) => call("/v1/blueprint", identity, input),
  };
}
