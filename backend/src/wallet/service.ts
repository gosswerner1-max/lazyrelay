import { supabase } from "../supabase.js";
import { createWalletLedger, type BalanceResult, type GrantResult, type LotKind } from "./ledger.js";
import { isLegacyAccount } from "./legacy.js";
import { microToCredits } from "./money.js";
import { signupGrant } from "./rules.js";

/** One credit lot as the balance needs it. */
export interface LotRow {
  kind: LotKind;
  remainingMicro: number;
  reservedMicro: number;
  expiresAt: string | null;
}

export interface WalletServiceDeps {
  ledger: {
    balance(accountId: string, now: Date): Promise<BalanceResult>;
    grant(input: { accountId: string; kind: "signup" | "pack"; credits: number; sourceKey: string }): Promise<GrantResult>;
  };
  readLots(accountId: string, now: Date): Promise<{ lots: LotRow[]; activeHolds: number }>;
  isLegacy(accountId: string): Promise<boolean>;
  isEmailConfirmed(accountId: string): Promise<boolean>;
  now(): Date;
}

export interface BalanceView {
  spendableMicro: number;
  heldMicro: number;
  byKindMicro: Record<LotKind, number>;
  displayCredits: string;
  heldCredits: string;
  nextExpiryAt: string | null;
  nextExpiryCredits: string | null;
  activeHolds: number;
}

export type SignupGrantOutcome =
  | { granted: true; reason: "granted" }
  | { granted: false; reason: "replay" | "legacy" | "email_unconfirmed" };

export function createWalletService(deps: WalletServiceDeps) {
  return {
    /** Spendable micro credits split by lot kind (expired lots left out), the display figure, the next expiry and the active holds. */
    async getBalance(accountId: string): Promise<BalanceView> {
      const now = deps.now();
      const [bal, { lots, activeHolds }] = await Promise.all([deps.ledger.balance(accountId, now), deps.readLots(accountId, now)]);
      const byKindMicro: Record<LotKind, number> = { signup: 0, pack: 0, subscription: 0 };
      for (const lot of lots) {
        if (lot.expiresAt !== null && new Date(lot.expiresAt).getTime() <= now.getTime()) continue;
        byKindMicro[lot.kind] += Math.max(0, lot.remainingMicro - lot.reservedMicro);
      }
      return {
        spendableMicro: bal.spendableMicro,
        heldMicro: bal.heldMicro,
        byKindMicro,
        displayCredits: microToCredits(bal.spendableMicro),
        heldCredits: microToCredits(bal.heldMicro),
        nextExpiryAt: bal.nextExpiryAt,
        nextExpiryCredits: bal.nextExpiryMicro === null ? null : microToCredits(bal.nextExpiryMicro),
        activeHolds,
      };
    },

    /**
     * Gives the one time signup credits. Only for a confirmed e-mail, never for a grandfathered account, and safe to call any number of
     * times: the key is signup:{accountId}, so the database grants once and reports a replay afterwards.
     */
    async ensureSignupGrant(accountId: string): Promise<SignupGrantOutcome> {
      if (await deps.isLegacy(accountId)) return { granted: false, reason: "legacy" };
      if (!(await deps.isEmailConfirmed(accountId))) return { granted: false, reason: "email_unconfirmed" };
      const g = signupGrant(accountId);
      const r = await deps.ledger.grant({ accountId, kind: g.kind, credits: g.credits, sourceKey: g.sourceKey });
      return r.replay ? { granted: false, reason: "replay" } : { granted: true, reason: "granted" };
    },
  };
}

export type WalletService = ReturnType<typeof createWalletService>;

/** The lots that still count and the number of open holds, read with the service role. Expiry is judged by the caller. */
async function readLotsFromDatabase(accountId: string): Promise<{ lots: LotRow[]; activeHolds: number }> {
  const lotsQ = await supabase.from("wallet_lots").select("kind, remaining_units, reserved_units, expires_at, expired_at").eq("account_id", accountId);
  if (lotsQ.error) throw new Error(`wallet lots read failed: ${lotsQ.error.message}`);
  const holdsQ = await supabase.from("wallet_holds").select("id").eq("account_id", accountId).eq("status", "held");
  if (holdsQ.error) throw new Error(`wallet holds read failed: ${holdsQ.error.message}`);
  const lots = (lotsQ.data ?? [])
    .filter((r) => r.expired_at == null)
    .map((r) => ({ kind: r.kind as LotKind, remainingMicro: Number(r.remaining_units), reservedMicro: Number(r.reserved_units), expiresAt: (r.expires_at as string | null) ?? null }));
  return { lots, activeHolds: (holdsQ.data ?? []).length };
}

/** True when the account's owner has confirmed the e-mail address (Supabase auth). A failed read is an error, never "confirmed". */
async function emailConfirmedFromDatabase(accountId: string): Promise<boolean> {
  const owner = await supabase.from("account_members").select("user_id").eq("account_id", accountId).eq("role", "owner").maybeSingle();
  if (owner.error) throw new Error(`account owner read failed: ${owner.error.message}`);
  if (!owner.data) return false;
  const user = await supabase.auth.admin.getUserById(owner.data.user_id as string);
  if (user.error) throw new Error(`auth user read failed: ${user.error.message}`);
  return Boolean(user.data.user?.email_confirmed_at);
}

let shared: WalletService | null = null;
/** The real service, built on first use so importing this file never touches the database. */
export function getWalletService(): WalletService {
  shared ??= createWalletService({
    ledger: createWalletLedger(supabase as never),
    readLots: (id) => readLotsFromDatabase(id),
    isLegacy: isLegacyAccount,
    isEmailConfirmed: emailConfirmedFromDatabase,
    now: () => new Date(),
  });
  return shared;
}
