import { MAX_MICRO, WalletValueError, creditsToMicro } from "./money.js";
import { isWalletAction, type WalletAction } from "./prices.js";
import { isSku } from "./catalog.js";

// The client side of the wallet (migration 0140). It validates everything BEFORE a request is made, sends an action name and a count
// (never an amount) for a spend, and checks the shape of every answer. The database enforces the same rules again. Every amount that
// comes back is in micro credits (1 credit = 1,000,000).

/** The slice of the Supabase client this uses, so a test can stand in for it. */
export interface WalletRpc {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
}

export type WalletErrorCode = "unavailable" | "key_conflict" | "bad_answer";

/** The message is fixed on purpose: database text can hold addresses, role names or values. */
export class WalletError extends Error {
  readonly code: WalletErrorCode;
  constructor(code: WalletErrorCode) {
    super(code === "key_conflict" ? "this key was already used for a different change" : code === "bad_answer" ? "the wallet gave an unexpected answer" : "the wallet is not available right now");
    this.name = "WalletError";
    this.code = code;
  }
}

export interface Short {
  ok: false;
  reason: "insufficient_credits";
  balanceMicro: number;
  requiredMicro: number;
}
export type ChargeResult =
  | { ok: true; replay: boolean; chargedMicro: number; balanceMicro: number }
  | { ok: true; replay: false; exempt: true; chargedMicro: 0; balanceMicro: number }
  | Short;
export type HoldResult =
  | { ok: true; replay: boolean; holdId: string; heldMicro: number }
  | { ok: true; replay: false; exempt: true; heldMicro: 0 }
  | Short;
export type CommitResult = { ok: true; replay: boolean; committedMicro: number; balanceMicro: number } | { ok: false; reason: "hold_not_held"; status: string };
export type ReleaseResult = { ok: true; replay: boolean } | { ok: false; reason: "hold_not_held"; status: string };
export interface GrantResult {
  ok: true;
  replay: boolean;
  lotId: string;
  grantedMicro: number;
  balanceMicro: number;
}
export type SkuGrantResult = GrantResult | { ok: false; reason: "plan_required"; requiredPlan: string };
export type PlanEventResult = { ok: true; outcome: "no_lapse" } | { ok: true; replay: boolean; lotsRevoked: number; expiredMicro: number };
export interface BalanceResult {
  spendableMicro: number;
  heldMicro: number;
  nextExpiryAt: string | null;
  nextExpiryMicro: number | null;
}

export type LotKind = "signup" | "pack" | "subscription";
export const PLAN_EVENTS = ["past_due_retry", "billing_gave_up", "voluntary_cancel", "chargeback", "refund", "admin_termination"] as const;
export type PlanEvent = (typeof PLAN_EVENTS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9:_.\-]{1,128}$/;
const SOURCE_KEY = /^[A-Za-z0-9:_.\-]{1,100}$/;
const PLAN = /^[a-z_]{1,32}$/;
const MAX_UNITS = 10_000;

function uuid(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new WalletValueError(`the ${what} is not valid`);
  return value;
}
function key(value: unknown): string {
  if (typeof value !== "string" || !KEY.test(value)) throw new WalletValueError("the idempotency key must be 1 to 128 letters, digits or : _ . -");
  return value;
}
function sourceKey(value: unknown): string {
  if (typeof value !== "string" || !SOURCE_KEY.test(value)) throw new WalletValueError("the source key must be 1 to 100 letters, digits or : _ . -");
  return value;
}
function action(value: unknown): WalletAction {
  if (!isWalletAction(value)) throw new WalletValueError("unknown wallet action");
  return value;
}
function plan(value: unknown): string {
  if (typeof value !== "string" || !PLAN.test(value)) throw new WalletValueError("the plan is not valid");
  return value;
}
function iso(value: Date, what: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new WalletValueError(`${what} is not a valid date`);
  return value.toISOString();
}
const nonNegativeSafe = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_MICRO * 1000;
const record = (data: unknown): Record<string, unknown> | null => (data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null);

function fail(error: { code?: string }): never {
  throw new WalletError(error.code === "23505" ? "key_conflict" : "unavailable");
}
function bad(): never {
  throw new WalletError("bad_answer");
}

function short(d: Record<string, unknown>): Short | null {
  if (d.ok === false && d.reason === "insufficient_credits" && nonNegativeSafe(d.balance_micro) && nonNegativeSafe(d.required_micro)) {
    return { ok: false, reason: "insufficient_credits", balanceMicro: d.balance_micro, requiredMicro: d.required_micro };
  }
  return null;
}
function parseGrant(d: Record<string, unknown>): GrantResult {
  if (d.ok === true && typeof d.replay === "boolean" && typeof d.lot_id === "string" && UUID.test(d.lot_id) && nonNegativeSafe(d.granted_micro) && d.granted_micro > 0 && nonNegativeSafe(d.balance_micro)) {
    return { ok: true, replay: d.replay, lotId: d.lot_id, grantedMicro: d.granted_micro, balanceMicro: d.balance_micro };
  }
  return bad();
}

export function createWalletLedger(client: WalletRpc) {
  async function call(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data, error } = await client.rpc(fn, args);
    if (error) return fail(error);
    return record(data) ?? bad();
  }

  return {
    async charge(input: { accountId: string; action: WalletAction; units?: number; idempotencyKey: string }): Promise<ChargeResult> {
      const id = uuid(input.accountId, "account id");
      const act = action(input.action);
      const units = input.units ?? 1;
      if (!Number.isInteger(units) || units < 1 || units > MAX_UNITS) throw new WalletValueError(`units must be a whole number from 1 to ${MAX_UNITS}`);
      const d = await call("wallet_charge", { p_account_id: id, p_action: act, p_units: units, p_key: key(input.idempotencyKey) });
      // A grandfathered account: the database answers exempt with a charge of exactly zero. Anything else claiming exempt is refused.
      if (d.ok === true && d.exempt === true) return d.replay === false && d.charged_micro === 0 && nonNegativeSafe(d.balance_micro) ? { ok: true, replay: false, exempt: true, chargedMicro: 0, balanceMicro: d.balance_micro } : bad();
      const s = short(d);
      if (s) return s;
      if (d.ok === true && typeof d.replay === "boolean" && nonNegativeSafe(d.charged_micro) && d.charged_micro > 0 && nonNegativeSafe(d.balance_micro)) {
        return { ok: true, replay: d.replay, chargedMicro: d.charged_micro, balanceMicro: d.balance_micro };
      }
      return bad();
    },

    async hold(input: { accountId: string; action: WalletAction; idempotencyKey: string }): Promise<HoldResult> {
      const d = await call("wallet_hold", { p_account_id: uuid(input.accountId, "account id"), p_action: action(input.action), p_key: key(input.idempotencyKey) });
      if (d.ok === true && d.exempt === true) return d.replay === false && d.held_micro === 0 ? { ok: true, replay: false, exempt: true, heldMicro: 0 } : bad();
      const s = short(d);
      if (s) return s;
      if (d.ok === true && typeof d.replay === "boolean" && typeof d.hold_id === "string" && UUID.test(d.hold_id) && nonNegativeSafe(d.held_micro) && d.held_micro > 0) {
        return { ok: true, replay: d.replay, holdId: d.hold_id, heldMicro: d.held_micro };
      }
      return bad();
    },

    async commit(holdId: string): Promise<CommitResult> {
      const d = await call("wallet_commit", { p_hold_id: uuid(holdId, "hold id") });
      if (d.ok === false && d.reason === "hold_not_held" && typeof d.status === "string") return { ok: false, reason: "hold_not_held", status: d.status };
      if (d.ok === true && typeof d.replay === "boolean" && nonNegativeSafe(d.committed_micro) && nonNegativeSafe(d.balance_micro)) {
        return { ok: true, replay: d.replay, committedMicro: d.committed_micro, balanceMicro: d.balance_micro };
      }
      return bad();
    },

    async release(holdId: string): Promise<ReleaseResult> {
      const d = await call("wallet_release", { p_hold_id: uuid(holdId, "hold id") });
      if (d.ok === false && d.reason === "hold_not_held" && typeof d.status === "string") return { ok: false, reason: "hold_not_held", status: d.status };
      return d.ok === true && typeof d.replay === "boolean" ? { ok: true, replay: d.replay } : bad();
    },

    /** A direct grant in whole credits (the signup allowance, or a pack). A subscription lot needs its period end, so it goes through grantForSku. */
    async grant(input: { accountId: string; kind: "signup" | "pack"; credits: number; sourceKey: string }): Promise<GrantResult> {
      if (input.kind !== "signup" && input.kind !== "pack") throw new WalletValueError("kind must be signup or pack");
      const d = await call("wallet_grant", { p_account_id: uuid(input.accountId, "account id"), p_kind: input.kind, p_units: creditsToMicro(input.credits), p_expires_at: null, p_source_key: sourceKey(input.sourceKey) });
      return parseGrant(d);
    },

    /** Grants a catalog SKU: the amount, the lot kind and the plan gate come from the database, never from here. */
    async grantForSku(input: { accountId: string; sku: string; sourceKey: string; now: Date; activePlan: string | null; periodEnd?: Date }): Promise<SkuGrantResult> {
      if (!isSku(input.sku)) throw new WalletValueError("unknown sku");
      const d = await call("wallet_grant_for_sku", {
        p_account_id: uuid(input.accountId, "account id"),
        p_sku: input.sku,
        p_source_key: sourceKey(input.sourceKey),
        p_now: iso(input.now, "now"),
        p_active_plan: input.activePlan === null ? null : plan(input.activePlan),
        p_period_end: input.periodEnd ? iso(input.periodEnd, "the period end") : null,
      });
      if (d.ok === false && d.reason === "plan_required" && typeof d.required_plan === "string") return { ok: false, reason: "plan_required", requiredPlan: d.required_plan };
      return parseGrant(d);
    },

    /** The lapse policy lives in the database (wallet_handle_plan_event); the webhook handler only names the event. */
    async handlePlanEvent(input: { accountId: string; plan: string; event: PlanEvent; periodEnd?: Date; idempotencyKey: string; now: Date }): Promise<PlanEventResult> {
      if (!(PLAN_EVENTS as readonly string[]).includes(input.event)) throw new WalletValueError("unknown plan event");
      if (input.event === "voluntary_cancel" && !input.periodEnd) throw new WalletValueError("a voluntary cancel needs the period end");
      const d = await call("wallet_handle_plan_event", {
        p_account_id: uuid(input.accountId, "account id"),
        p_plan: plan(input.plan),
        p_event: input.event,
        p_period_end: input.periodEnd ? iso(input.periodEnd, "the period end") : null,
        p_key: key(input.idempotencyKey),
        p_now: iso(input.now, "now"),
      });
      if (d.ok === true && d.outcome === "no_lapse") return { ok: true, outcome: "no_lapse" };
      if (d.ok === true && typeof d.replay === "boolean" && nonNegativeSafe(d.lots_revoked) && nonNegativeSafe(d.expired_micro)) {
        return { ok: true, replay: d.replay, lotsRevoked: d.lots_revoked, expiredMicro: d.expired_micro };
      }
      return bad();
    },

    async balance(accountId: string, now: Date): Promise<BalanceResult> {
      const d = await call("wallet_balance", { p_account_id: uuid(accountId, "account id"), p_now: iso(now, "now") });
      const expiryOk = (d.next_expiry_at === null && d.next_expiry_micro === null) || (typeof d.next_expiry_at === "string" && nonNegativeSafe(d.next_expiry_micro));
      if (!nonNegativeSafe(d.spendable_micro) || !nonNegativeSafe(d.held_micro) || !expiryOk) return bad();
      return { spendableMicro: d.spendable_micro, heldMicro: d.held_micro, nextExpiryAt: d.next_expiry_at as string | null, nextExpiryMicro: d.next_expiry_micro as number | null };
    },

    async expire(now: Date): Promise<{ expiredLots: number; expiredMicro: number }> {
      const d = await call("wallet_expire", { p_now: iso(now, "now") });
      return nonNegativeSafe(d.expired_lots) && nonNegativeSafe(d.expired_micro) ? { expiredLots: d.expired_lots, expiredMicro: d.expired_micro } : bad();
    },

    async expireHolds(now: Date): Promise<{ expiredHolds: number }> {
      const d = await call("wallet_expire_holds", { p_now: iso(now, "now") });
      return nonNegativeSafe(d.expired_holds) ? { expiredHolds: d.expired_holds } : bad();
    },
  };
}
