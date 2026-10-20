// The paid way into competitor mode. When credits are switched on (VITE_BILLING_ENABLED), the competitor box asks the
// LazyRelay backend for the blueprint instead of the engine, so the backend can charge credits and deliver the result
// in one step. This file is the thin client for that one route plus the plain words for what it can answer.
// Nothing here is imported unless the setting is "true", so a build without it carries none of these sentences.
//
// The idempotency key is never made in here. The screen makes one when the person confirms the notice and hands it to
// every attempt of that confirmed run, so a double click or a retry cannot be charged twice.

import { readBlueprint, type CompetitorBlueprint } from "./competitorBlueprint";
import { CompetitorError, errorFor, type CompetitorClient } from "./competitorMode";

/** The LazyRelay API call that signs the request with the customer's sign in (authedFetch has this shape). */
export type BillingFetcher = (path: string, options?: RequestInit) => Promise<unknown>;

export const TEARDOWN_PATH = "/wallet/teardown";
export const TEARDOWN_CREDITS = 10;

export const COST_NOTICE = `This costs ${TEARDOWN_CREDITS} credits when a blueprint is delivered. You are not charged if it fails.`;
export const ADD_CREDITS_LABEL = "Add credits";
export const balanceNotice = (balance: number) => `Your balance: ${balance} credits.`;

export const ALREADY_CHARGED_MESSAGE = "This analysis was already run and charged. Run it again to see it.";
export const IN_FLIGHT_MESSAGE = "A teardown is already running. Please wait for it to finish.";
export const IDEMPOTENCY_CONFLICT_MESSAGE = "That request was already used. Please try again.";
const NOT_ON_YET_MESSAGE = "This feature is not switched on yet.";

export function insufficientCreditsMessage(balance?: number, required: number = TEARDOWN_CREDITS): string {
  const need = `You need ${required} credits for a competitor teardown.`;
  return typeof balance === "number" ? `${need} You have ${balance}.` : need;
}

/** A fresh v4 id for one confirmed run. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------- Errors ----------

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const finiteNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function billingError(err: Record<string, unknown>, status: number | undefined, code: string | undefined): CompetitorError | null {
  if (status === 402 || code === "insufficient_credits") {
    return new CompetitorError("insufficient_credits", insufficientCreditsMessage(finiteNumber(err.balance), finiteNumber(err.required)));
  }
  if (code === "in_flight") return new CompetitorError("in_flight", IN_FLIGHT_MESSAGE);
  if (code === "idempotency_conflict") return new CompetitorError("idempotency_conflict", IDEMPOTENCY_CONFLICT_MESSAGE);
  if (status === 404) return new CompetitorError("not_connected", NOT_ON_YET_MESSAGE);
  return null;
}

/** Every failure becomes one CompetitorError. The raw error is never shown; a non-HTTP one goes to the console only. */
function toCompetitorError(err: unknown, signal: AbortSignal | undefined): CompetitorError {
  if (err instanceof CompetitorError) return err;
  if (signal?.aborted || (isObject(err) && err.name === "AbortError")) return new CompetitorError("timeout");
  if (isObject(err) && typeof err.status === "number") {
    const code = typeof err.code === "string" ? err.code : undefined;
    return billingError(err, err.status, code) ?? errorFor(code, err.status, err.message);
  }
  if (err instanceof Error && err.message === "Not signed in") return new CompetitorError("sign_in");
  console.error(err); // the raw error stays in the console; it never holds the token
  return new CompetitorError("network");
}

// ---------- Reading the answer ----------

/** The backend's answer in the shape the screen already reads: the engine's blueprint plus what was charged and the balance. */
function readAnswer(body: unknown): CompetitorBlueprint {
  if (!isObject(body)) throw new CompetitorError("bad_response");
  if (body.replay === true) throw new CompetitorError("already_charged", ALREADY_CHARGED_MESSAGE);
  const inner = isObject(body.blueprint) ? body.blueprint : null;
  if (!inner) throw new CompetitorError("bad_response");
  const whole = isObject(inner.blueprint) ? inner : { kind: body.kind ?? inner.kind, sourceUrl: body.sourceUrl ?? inner.sourceUrl, title: body.title ?? inner.title, blueprint: inner };
  const result = readBlueprint({ ...whole, creditsUsed: body.chargedCredits });
  if (!result) throw new CompetitorError("bad_response");
  const balance = finiteNumber(body.balance);
  return balance === undefined ? result : { ...result, balance };
}

// ---------- The client ----------

/** Same client shape the panel already uses, so the panel does not know which route it is on. */
export function createBillingCompetitorClient(fetcher: BillingFetcher): CompetitorClient {
  return {
    async blueprint(input, signal, idempotencyKey) {
      if (!idempotencyKey) throw new CompetitorError("unknown"); // a run without its key is never sent
      let body: unknown;
      try {
        body = await fetcher(TEARDOWN_PATH, { method: "POST", body: JSON.stringify({ input, idempotencyKey, consent: true }), signal });
      } catch (err) {
        throw toCompetitorError(err, signal);
      }
      return readAnswer(body);
    },
  };
}
