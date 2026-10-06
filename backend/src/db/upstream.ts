// Shared vocabulary for "the database could not answer".
//
// supabase-js never throws on a failed call: it returns { data: null, error }.
// Code that destructures only `data` therefore reads "request failed" as "no
// rows", which is how a paying customer can come out as "free" or a published
// post as "never published" during a gateway blip. These helpers make the
// difference between "no rows" and "could not ask" explicit.

export const DB_UNAVAILABLE_MESSAGE = "Database unavailable - Retry pending";

/** The database did not give a usable answer. Callers must treat the state as
 *  unknown and retry later; they must never substitute a default value. */
export class UpstreamUnavailableError extends Error {
  readonly op: string;
  readonly detail: string;
  constructor(op: string, detail: string) {
    super(DB_UNAVAILABLE_MESSAGE);
    this.name = "UpstreamUnavailableError";
    this.op = op;
    this.detail = detail;
  }
}

export function isUpstreamUnavailable(err: unknown): err is UpstreamUnavailableError {
  return err instanceof UpstreamUnavailableError;
}

interface DbError {
  message?: string;
  code?: string;
}

interface DbStatus {
  error: DbError | null;
  status?: number;
}

// HTTP statuses that mean the gateway or database could not be reached or did
// not answer in time (520 to 530 are Cloudflare's own origin-failure codes,
// 522 being connection timed out), as opposed to the database answering "no".
const TRANSIENT_STATUSES = new Set([408, 502, 503, 504]);

export function isTransientStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 0 || TRANSIENT_STATUSES.has(status) || (status >= 520 && status <= 530);
}

const TRANSIENT_TEXT = /fetch failed|aborted|timed out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|<html|<!doctype/i;

/** True when a result's error looks like an outage rather than a real answer. */
export function isTransientDbError(res: DbStatus): boolean {
  if (!res.error) return false;
  if (isTransientStatus(res.status)) return true;
  return TRANSIENT_TEXT.test(res.error.message ?? "");
}

function describe(res: DbStatus): string {
  // The raw message can be a whole HTML error page: keep it short for logs.
  const text = (res.error?.message ?? "no message").replace(/\s+/g, " ").trim();
  return `${res.status ?? "?"} ${text.slice(0, 160)}`;
}

/** Returns the data (null for a genuine "no rows"). Throws
 *  UpstreamUnavailableError for ANY error, because for a read an error means
 *  the answer is unknown, never "empty". */
export function readOrUnavailable<T>(res: DbStatus & { data: T }, op: string): T {
  if (res.error) throw new UpstreamUnavailableError(op, describe(res));
  return res.data;
}

/** For a write: throws only when the failure is transient, so a constraint or
 *  permission error keeps whatever handling the caller already had. */
export function throwIfTransient(res: DbStatus, op: string): void {
  if (res.error && isTransientDbError(res)) throw new UpstreamUnavailableError(op, describe(res));
}
