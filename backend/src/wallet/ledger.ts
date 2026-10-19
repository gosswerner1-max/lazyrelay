import { MAX_MICRO, WalletValueError, assertPositiveMicro } from "./money.js";
import { isWalletAction, type WalletAction } from "./prices.js";

// The client side of the wallet. It validates everything BEFORE a request is made, sends an action name and a unit count (never an
// amount) for a charge, and checks the shape of every answer. The database (migration 0139) enforces the same rules again.

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

export type ChargeResult =
  | { ok: true; replay: boolean; chargedMicro: number; balanceMicro: number }
  | { ok: false; reason: "insufficient_funds"; balanceMicro: number; requiredMicro: number };

export interface CreditResult {
  ok: true;
  replay: boolean;
  creditedMicro: number;
  balanceMicro: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9:_.\-]{1,128}$/;
const MAX_UNITS = 10_000;

function accountId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new WalletValueError("the account id is not valid");
  return value;
}
function key(value: unknown): string {
  if (typeof value !== "string" || !KEY.test(value)) throw new WalletValueError("the idempotency key must be 1 to 128 letters, digits or : _ . -");
  return value;
}
const nonNegativeSafe = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_MICRO * 1000;

function fail(error: { code?: string }): never {
  throw new WalletError(error.code === "23505" ? "key_conflict" : "unavailable");
}

export function createWalletLedger(client: WalletRpc) {
  return {
    async charge(input: { accountId: string; action: WalletAction; units?: number; idempotencyKey: string }): Promise<ChargeResult> {
      const id = accountId(input.accountId);
      if (!isWalletAction(input.action)) throw new WalletValueError("unknown wallet action");
      const units = input.units ?? 1;
      if (!Number.isInteger(units) || units < 1 || units > MAX_UNITS) throw new WalletValueError(`units must be a whole number from 1 to ${MAX_UNITS}`);
      const idempotencyKey = key(input.idempotencyKey);

      const { data, error } = await client.rpc("wallet_charge", { p_account_id: id, p_action: input.action, p_units: units, p_key: idempotencyKey });
      if (error) return fail(error);
      const d = data as Record<string, unknown> | null;
      if (d && d.ok === false && d.reason === "insufficient_funds" && nonNegativeSafe(d.balance_micro) && nonNegativeSafe(d.required_micro)) {
        return { ok: false, reason: "insufficient_funds", balanceMicro: d.balance_micro, requiredMicro: d.required_micro };
      }
      if (d && d.ok === true && typeof d.replay === "boolean" && nonNegativeSafe(d.charged_micro) && (d.charged_micro as number) > 0 && nonNegativeSafe(d.balance_micro)) {
        return { ok: true, replay: d.replay, chargedMicro: d.charged_micro as number, balanceMicro: d.balance_micro };
      }
      throw new WalletError("bad_answer");
    },

    async credit(input: { accountId: string; amountMicro: number; idempotencyKey: string; reference?: string; kind?: "top_up" | "refund" | "grant" }): Promise<CreditResult> {
      const id = accountId(input.accountId);
      const amount = assertPositiveMicro(input.amountMicro);
      const idempotencyKey = key(input.idempotencyKey);
      const kind = input.kind ?? "top_up";
      if (kind !== "top_up" && kind !== "refund" && kind !== "grant") throw new WalletValueError("kind must be top_up, refund or grant");
      if (input.reference !== undefined && (typeof input.reference !== "string" || input.reference.length > 200)) throw new WalletValueError("the reference is too long");

      const { data, error } = await client.rpc("wallet_credit", { p_account_id: id, p_amount_micro: amount, p_key: idempotencyKey, p_reference: input.reference ?? null, p_kind: kind });
      if (error) return fail(error);
      const d = data as Record<string, unknown> | null;
      if (d && d.ok === true && typeof d.replay === "boolean" && nonNegativeSafe(d.credited_micro) && (d.credited_micro as number) > 0 && nonNegativeSafe(d.balance_micro)) {
        return { ok: true, replay: d.replay, creditedMicro: d.credited_micro as number, balanceMicro: d.balance_micro };
      }
      throw new WalletError("bad_answer");
    },
  };
}
