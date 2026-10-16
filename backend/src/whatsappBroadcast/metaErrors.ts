// What a failed WhatsApp send, or a failed delivery receipt, means. Decided ONLY from Meta's numeric error code and the HTTP
// status, never from its message text (the text can echo request details). Every reason returned is a short code of ours.
//
// Order matters and is the point of this file:
//   1. an opt-out (131050) is honoured and recorded, whatever else the response says;
//   2. a restriction, quality or credential problem pauses the CONNECTION, even if the HTTP status looks transient: we never
//      retry into a restriction, because repeated sends against a flagged number make the flag worse;
//   3. a template problem stops the BROADCAST (every other recipient would fail the same way);
//   4. only then is a transient error retried (at most MAX_TRANSIENT_RETRIES times);
//   5. a request that got no answer is NOT retried: the message may already have gone out, and sending again could message a
//      person twice. It is failed as "unconfirmed" and the customer sees it as such.
//
// The code lists come from Meta's WhatsApp Cloud API error reference as understood on 2026-10-16. They were NOT re-verified
// against Meta's live documentation or a live account in this build; an unknown code falls through to "that recipient failed,
// not retried", which is the safe direction.

export type PauseReason = "quality" | "restricted" | "credentials" | "template" | "policy";

export type FailureAction =
  | { kind: "opt_out"; reason: "recipient_opted_out" }
  | { kind: "pause_connection"; pause: PauseReason; reason: string }
  | { kind: "pause_broadcast"; reason: "template_unusable" }
  | { kind: "retry"; reason: string }
  | { kind: "recipient_failed"; reason: string };

export interface MetaFailure {
  httpStatus?: number;
  code?: number | null;
  /** The request got no answer at all (network error or timeout). */
  noResponse?: boolean;
}

/** At most this many retries after the first attempt, and only for transient errors. */
export const MAX_TRANSIENT_RETRIES = 3;

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

/** How long to wait before retry number n (1 = first retry). */
export function retryDelayMs(retryNumber: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(retryNumber, 1), RETRY_DELAYS_MS.length) - 1];
}

const OPT_OUT_CODE = 131050;
const RESTRICTED_CODES = new Set([131031, 130497, 131042, 131037]);
const POLICY_CODES = new Set([368]);
const QUALITY_CODES = new Set([131048]);
const TEMPLATE_CODES = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016]);
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 613, 80007, 130429, 131016]);

export function classifyMetaFailure(f: MetaFailure): FailureAction {
  if (f.noResponse) return { kind: "recipient_failed", reason: "unconfirmed_no_response" };
  const code = typeof f.code === "number" ? f.code : null;
  const status = f.httpStatus ?? null;

  if (code === OPT_OUT_CODE) return { kind: "opt_out", reason: "recipient_opted_out" };

  if (code !== null && POLICY_CODES.has(code)) return { kind: "pause_connection", pause: "policy", reason: "connection_policy_block" };
  if (code !== null && RESTRICTED_CODES.has(code)) return { kind: "pause_connection", pause: "restricted", reason: "connection_restricted" };
  if (code !== null && QUALITY_CODES.has(code)) return { kind: "pause_connection", pause: "quality", reason: "connection_quality_limit" };
  if (status === 401 || status === 403 || (code !== null && (code === 190 || code === 10 || (code >= 200 && code <= 299)))) {
    return { kind: "pause_connection", pause: "credentials", reason: "connection_credentials" };
  }

  if (code !== null && TEMPLATE_CODES.has(code)) return { kind: "pause_broadcast", reason: "template_unusable" };

  if (status === 429 || (status !== null && status >= 500) || (code !== null && TRANSIENT_CODES.has(code))) {
    return { kind: "retry", reason: "transient_error" };
  }

  return { kind: "recipient_failed", reason: code !== null ? `meta_error_${code}` : "meta_rejected" };
}
