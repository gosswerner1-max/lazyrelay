// Wallet amounts are whole micro credits (1 credit = 1,000,000), the same unit the wallet tables use, so no amount is ever a floating point number.
// Every function here refuses anything that is not strictly positive, whole and inside the limit, and says so with a WalletValueError.

/** The most one amount may be, in micro credits (1,000,000 credits). The database enforces the same limit. */
export const MAX_MICRO = 1_000_000_000_000;

export class WalletValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletValueError";
  }
}

// Since migration 0140 the wallet counts CREDITS, not dollars. The unit is the micro credit: 1 credit = 1,000,000 micro credits. The
// columns and helpers keep their "micro" names; only the unit changed. Dollars live on the Paddle sale, never in the ledger.
export const MICRO_PER_CREDIT = 1_000_000;

/** 300 credits become 300,000,000 micro credits. Only whole credits above zero and inside the limit are accepted. */
export function creditsToMicro(credits: number): number {
  if (typeof credits !== "number" || !Number.isSafeInteger(credits) || credits <= 0 || credits * MICRO_PER_CREDIT > MAX_MICRO) {
    throw new WalletValueError("credits must be a whole number above zero and within the limit");
  }
  return credits * MICRO_PER_CREDIT;
}

/** 10_000_000 becomes "10", 500_000 becomes "0.5". For display and logs only. */
export function microToCredits(micro: number): string {
  if (!Number.isSafeInteger(micro) || micro < 0) throw new WalletValueError("micro credits must be a whole number, 0 or more");
  const whole = Math.floor(micro / MICRO_PER_CREDIT);
  const fraction = String(micro % MICRO_PER_CREDIT).padStart(6, "0").replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${whole}.${fraction}`;
}
