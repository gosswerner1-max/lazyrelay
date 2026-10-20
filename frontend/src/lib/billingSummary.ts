// Pure summary logic for the credit balance widgets. The lot shape mirrors the future wallet balance. Nothing here reads the
// clock: every function that depends on the time takes `now`. Dates are shown in UTC as YYYY-MM-DD.

export type LotKind = "subscription" | "topup" | "pack" | "signup";

export interface CreditLot {
  kind: LotKind;
  /** Whole credits left in this lot. */
  remaining: number;
  /** ISO timestamp, or null when the lot never expires. */
  expiresAt: string | null;
  boundPlan?: "pro";
  /** Only meaningful on a subscription lot. */
  autoRenew?: boolean;
  /** Display name of the plan on a subscription lot, for example "Pro". */
  planName?: string;
}

export type BalanceStatus = "high" | "medium" | "low";

const DAY_MS = 86_400_000;
const BANNER_WINDOW_DAYS = 7;
const HIGH_FROM = 100;
const MEDIUM_FROM = 21;
const KIND_ORDER: Record<LotKind, number> = { subscription: 0, topup: 1, pack: 2, signup: 3 };
const ROLLOVER_NOTE = "Unused plan credits do not roll over.";

/** A lot counts while it has no end date or its end is still ahead. */
function isActive(lot: CreditLot, now: Date): boolean {
  return lot.expiresAt === null || new Date(lot.expiresAt).getTime() > now.getTime();
}

function activeLots(lots: CreditLot[], now: Date): CreditLot[] {
  return lots.filter((lot) => isActive(lot, now));
}

function sumRemaining(lots: CreditLot[]): number {
  return lots.reduce((sum, lot) => sum + lot.remaining, 0);
}

export function totalCredits(lots: CreditLot[], now: Date): number {
  return sumRemaining(activeLots(lots, now));
}

export function balanceStatus(total: number): BalanceStatus {
  if (total >= HIGH_FROM) return "high";
  return total >= MEDIUM_FROM ? "medium" : "low";
}

const STATUS_LABEL: Record<BalanceStatus, string> = {
  high: "Balance is high",
  medium: "Balance is getting low",
  low: "Balance is critically low",
};

const STATUS_MARK: Record<BalanceStatus, string> = { high: "", medium: "Low", low: "Critical" };

export function statusLabel(status: BalanceStatus): string {
  return STATUS_LABEL[status];
}

/** Short visible text so the status never depends on colour alone. Empty when the balance is high. */
export function statusMark(status: BalanceStatus): string {
  return STATUS_MARK[status];
}

export function formatCredits(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function remainingMs(expiresAt: string, now: Date): number {
  return new Date(expiresAt).getTime() - now.getTime();
}

/** Remaining time rounded UP to whole days. 0 when the time is already up. */
export function wholeDaysLeft(expiresAt: string, now: Date): number {
  const ms = remainingMs(expiresAt, now);
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}

/** "today" under a day, "1 day" at exactly one day, otherwise "N days". */
export function describeCountdown(expiresAt: string, now: Date): string {
  if (remainingMs(expiresAt, now) < DAY_MS) return "today";
  const days = wholeDaysLeft(expiresAt, now);
  return days === 1 ? "1 day" : `${days} days`;
}

function isoDate(expiresAt: string): string {
  return new Date(expiresAt).toISOString().slice(0, 10);
}

/** "in 3 days" or just "today": the phrase that follows a verb such as "Resets". */
function inPhrase(expiresAt: string, now: Date): string {
  const text = describeCountdown(expiresAt, now);
  return text === "today" ? text : `in ${text}`;
}

export interface ExpirationNotice {
  kind: "subscription" | "topup";
  message: string;
}

function isExpiringLot(lot: CreditLot, now: Date): boolean {
  if (lot.kind !== "subscription" && lot.kind !== "topup") return false;
  if (lot.remaining <= 0 || lot.expiresAt === null || !isActive(lot, now)) return false;
  return remainingMs(lot.expiresAt, now) < BANNER_WINDOW_DAYS * DAY_MS;
}

function noticeMessage(lot: CreditLot, now: Date): string {
  const when = `${inPhrase(lot.expiresAt!, now)} (${isoDate(lot.expiresAt!)})`;
  if (lot.kind === "topup") return `Your Pro Top-Up credits expire ${when}.`;
  const plan = lot.planName ? `${lot.planName} Plan` : "Plan";
  return `Your ${plan} credits expire ${when}. ${ROLLOVER_NOTE}`;
}

/** The banner shows only for an expiring plan or top-up lot with less than 7 days left. It names the soonest one. */
export function expirationNotice(lots: CreditLot[], now: Date): ExpirationNotice | null {
  const soonest = lots
    .filter((lot) => isExpiringLot(lot, now))
    .sort((a, b) => remainingMs(a.expiresAt!, now) - remainingMs(b.expiresAt!, now) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind])[0];
  if (!soonest) return null;
  return { kind: soonest.kind === "topup" ? "topup" : "subscription", message: noticeMessage(soonest, now) };
}

export interface SubscriptionBlock {
  remaining: number;
  planName: string;
  countdown: string | null;
  rolloverNote: string;
}

export interface TopupBlock {
  remaining: number;
  lapse: string;
}

export interface PaygBlock {
  remaining: number;
  freeSignup: number;
}

export interface Allocation {
  subscription: SubscriptionBlock | null;
  topup: TopupBlock | null;
  payg: PaygBlock;
}

function soonestEnd(lots: CreditLot[]): CreditLot | undefined {
  return lots.filter((lot) => lot.expiresAt !== null).sort((a, b) => Date.parse(a.expiresAt!) - Date.parse(b.expiresAt!))[0];
}

function subscriptionBlock(subs: CreditLot[], now: Date): SubscriptionBlock | null {
  if (subs.length === 0) return null;
  const ending = soonestEnd(subs);
  const verb = subs.some((s) => s.autoRenew === false) ? "Ends" : "Resets";
  const countdown = ending ? `${verb} ${inPhrase(ending.expiresAt!, now)} on ${isoDate(ending.expiresAt!)}` : null;
  return { remaining: sumRemaining(subs), planName: subs[0]!.planName ?? "Plan", countdown, rolloverNote: ROLLOVER_NOTE };
}

function topupBlock(topups: CreditLot[], subs: CreditLot[], now: Date): TopupBlock | null {
  if (topups.length === 0) return null;
  const planEnd = soonestEnd(subs) ?? soonestEnd(topups);
  const cancelled = subs.some((s) => s.autoRenew === false);
  let lapse = "Linked to active Pro Plan.";
  if (planEnd) {
    const date = cancelled ? ` on ${isoDate(planEnd.expiresAt!)}` : "";
    lapse += ` Lapses ${inPhrase(planEnd.expiresAt!, now)}${date}.`;
  }
  return { remaining: sumRemaining(topups), lapse };
}

export function buildAllocation(lots: CreditLot[], now: Date): Allocation {
  const live = activeLots(lots, now);
  const subs = live.filter((l) => l.kind === "subscription");
  const topups = live.filter((l) => l.kind === "topup");
  const payg = live.filter((l) => l.kind === "pack" || l.kind === "signup");
  return {
    subscription: subscriptionBlock(subs, now),
    topup: topupBlock(topups, subs, now),
    payg: { remaining: sumRemaining(payg), freeSignup: sumRemaining(payg.filter((l) => l.kind === "signup")) },
  };
}
