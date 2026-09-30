// Error mapping. The kinds and hint rules are a port of describeApiError in the LazyRelay
// backend (backend/src/mcp/lazyrelayTools.ts), with the hints reworded for SDK method names.

export type ErrorKind = "validation" | "plan_limit" | "auth" | "permission" | "not_found" | "conflict" | "rate_limited" | "server" | "unknown";

export interface ErrorInfo {
  kind: ErrorKind;
  status: number;
  message: string;
  hint: string | null;
  retryable: boolean;
}

const HINTS: Array<{ test: RegExp; hint: string }> = [
  { test: /tiktokPrivacyLevel|privacy level/i, hint: "Call tiktok.creatorInfo(accountId) to see which privacy levels the account allows, then send tiktokPrivacyLevel." },
  { test: /board/i, hint: "Call pinterest.boards(accountId) and send boardId (and destinationLink if the platform needs one)." },
  { test: /options\./i, hint: "Call rules.get(platform) to see which options the platform takes and what each one needs." },
  { test: /plan|upgrade|paid|limit reached/i, hint: "This is a plan limit, not a mistake in the request. Tell the account owner instead of retrying." },
  { test: /warm|daily|24 hours|posting limit|rolling/i, hint: "The platform's posting limit is reached. Use slots.next(accountId) or pick a later time." },
  { test: /reconnect|expired|token/i, hint: "The connected account needs to be reconnected by its owner in the LazyRelay dashboard." },
  { test: /socialAccountId|not owned|account not found/i, hint: "Call accounts.list() to get valid account ids." },
  { test: /scheduledFor/i, hint: "scheduledFor must be an ISO 8601 timestamp in the future, for example 2026-10-01T09:00:00Z." },
];

/** Turns an HTTP status and the API's own error text into a kind, a hint and a retryable flag. */
export function describeApiError(status: number, message: string): ErrorInfo {
  let kind: ErrorKind = "unknown";
  if (status === 400 || status === 422) kind = "validation";
  else if (status === 401) kind = "auth";
  else if (status === 403) kind = /plan|upgrade|paid|allows \d+|limit/i.test(message) ? "plan_limit" : "permission";
  else if (status === 404) kind = "not_found";
  else if (status === 409) kind = "conflict";
  else if (status === 413) kind = "plan_limit"; // storage quota
  else if (status === 429) kind = "rate_limited";
  else if (status >= 500) kind = "server";
  const hint = HINTS.find((h) => h.test.test(message))?.hint ?? null;
  return { kind, status, message, hint, retryable: kind === "rate_limited" || kind === "server" };
}

/**
 * Thrown for every failure. `message` is the API's own `error` text. `status` is the HTTP status,
 * or 0 when no response arrived (network failure, timeout) or the request was refused before it
 * was sent. `body` is the parsed JSON body of the error response when there was one (some errors,
 * such as a platform daily limit, carry extra fields like `code` and `nextAvailable`).
 * The API key is never part of an error.
 */
export class LazyRelayError extends Error {
  readonly status: number;
  readonly kind: ErrorKind;
  readonly hint: string | null;
  readonly retryable: boolean;
  readonly body: unknown;

  constructor(info: ErrorInfo, body?: unknown) {
    super(info.message);
    this.name = "LazyRelayError";
    this.status = info.status;
    this.kind = info.kind;
    this.hint = info.hint;
    this.retryable = info.retryable;
    this.body = body;
  }

  /** Builds the error for an HTTP error response. */
  static fromResponse(status: number, message: string, body?: unknown): LazyRelayError {
    return new LazyRelayError(describeApiError(status, message), body);
  }

  /** Builds an error that has no HTTP response behind it. */
  static local(kind: ErrorKind, message: string, retryable = false): LazyRelayError {
    return new LazyRelayError({ kind, status: 0, message, hint: null, retryable });
  }
}
