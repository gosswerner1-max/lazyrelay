// Money is kept as whole micro dollars (1 USD = 1,000,000), the same unit the wallet tables use, so no amount is ever a floating point number.
// Every function here refuses anything that is not strictly positive, whole and inside the limit, and says so with a WalletValueError.

export const MICRO_PER_USD = 1_000_000;
/** The most one credit may be: 1,000,000 USD. The database enforces the same limit. */
export const MAX_MICRO = 1_000_000_000_000;

export class WalletValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletValueError";
  }
}

// Up to 6 whole digits of USD after the cap, no sign, no exponent, no spaces, 1 to 6 decimals when there is a point.
const DECIMAL = /^(0|[1-9][0-9]{0,6})(\.[0-9]{1,6})?$/;
const DIGITS = /^[1-9][0-9]{0,15}$/;

/** "0.002" becomes 2000. Only a string is accepted (a JavaScript number would already be a float), and the result must be above zero. */
export function usdToPositiveMicro(text: string): number {
  if (typeof text !== "string" || !DECIMAL.test(text)) throw new WalletValueError("an amount in USD must be a plain decimal such as 0.002, with at most 6 decimals");
  const [whole = "0", fraction = ""] = text.split(".");
  const micro = Number(whole) * MICRO_PER_USD + Number(fraction.padEnd(6, "0"));
  return assertPositiveMicro(micro);
}

/** The wallet only deals in amounts that are whole, safe, above zero and within the limit. */
export function assertPositiveMicro(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_MICRO) {
    throw new WalletValueError("a wallet amount must be a whole number of micro dollars above zero and within the limit");
  }
  return value;
}

/** 2000 becomes "0.002", 50000 becomes "0.05", 5000000 becomes "5". For display and logs only. */
export function microToUsd(micro: number): string {
  if (!Number.isSafeInteger(micro) || micro < 0) throw new WalletValueError("micro dollars must be a whole number, 0 or more");
  const whole = Math.floor(micro / MICRO_PER_USD);
  const fraction = String(micro % MICRO_PER_USD).padStart(6, "0").replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${whole}.${fraction}`;
}

/** Paddle reports amounts as a string in the smallest unit of the currency (cents for USD): "500" is 5.00 USD, which is 5,000,000 micro. */
export function minorUnitsToMicro(text: string): number {
  if (typeof text !== "string" || !DIGITS.test(text)) throw new WalletValueError("a Paddle amount must be a whole number of the smallest currency unit, above zero");
  return assertPositiveMicro(Number(text) * (MICRO_PER_USD / 100));
}

// Since migration 0140 the wallet counts CREDITS, not dollars. The unit is the micro credit: 1 credit = 1,000,000 micro credits. The
// columns and the helpers above keep their "micro" names; only the unit changed. Dollars live on the Paddle sale, never in the ledger.
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
