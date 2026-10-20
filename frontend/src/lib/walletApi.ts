// Reads of the credit wallet: the balance and the catalog of things that can be bought. Everything that comes back is checked
// field by field; an answer that does not have the agreed shape is treated as "unavailable" (the screens then behave as if
// billing were off) and never reaches a component. A failed call is turned into plain words; the raw error is kept on the
// result for the caller and never shown. The buying call lives in walletCheckout.ts so it only ships with the billing screens.

import { authedFetch } from "./api";
import type { CreditLot, LotKind } from "./billingSummary";

export type Fetcher = (path: string, options?: RequestInit) => Promise<unknown>;

export type WalletPlanName = "free" | "payg" | "growth" | "pro";

export interface Wallet {
  exempt: boolean;
  balance: number;
  held: number;
  lots: CreditLot[];
  nextExpiry: { at: string; credits: number } | null;
  paused: boolean;
  plan: { tier: string; walletPlan: WalletPlanName | null; caps: { accounts: number; brands: number | null; queued: number | null } };
  prices: { post_publish: number; competitor_teardown: number };
}

export type CatalogReason = "needs_pro" | "already_subscribed" | "legacy_account" | "plan_ending";

export interface CatalogItem {
  sku: string;
  name: string;
  kind: "pack" | "subscription";
  priceCents: number;
  credits: number;
  expires: boolean;
  interval: "one_time" | "month";
  requiresPlan: string | null;
  purchasable: boolean;
  reason: CatalogReason | null;
}

export type BalanceResult = { kind: "ok"; wallet: Wallet } | { kind: "unavailable" } | { kind: "error"; message: string; cause: unknown };
export type CatalogResult = { kind: "ok"; items: CatalogItem[] } | { kind: "unavailable" } | { kind: "error"; message: string; cause: unknown };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isDateText = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isCountOrNull = (v: unknown) => v === null || isCount(v);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T => typeof v === "string" && (allowed as readonly string[]).includes(v);

const LOT_KINDS: readonly LotKind[] = ["subscription", "topup", "pack", "signup"];
const WALLET_PLANS: readonly WalletPlanName[] = ["free", "payg", "growth", "pro"];
const REASONS: readonly CatalogReason[] = ["needs_pro", "already_subscribed", "legacy_account", "plan_ending"];

function readLot(v: unknown): CreditLot | null {
  if (!isObj(v) || !oneOf(v.kind, LOT_KINDS) || !isCount(v.remaining)) return null;
  if (v.expiresAt !== null && !isDateText(v.expiresAt)) return null;
  if (v.boundPlan !== undefined && v.boundPlan !== "pro") return null;
  if (v.autoRenew !== undefined && typeof v.autoRenew !== "boolean") return null;
  if (v.planName !== undefined && typeof v.planName !== "string") return null;
  const lot: CreditLot = { kind: v.kind, remaining: v.remaining, expiresAt: v.expiresAt };
  if (v.boundPlan === "pro") lot.boundPlan = "pro";
  if (typeof v.autoRenew === "boolean") lot.autoRenew = v.autoRenew;
  if (typeof v.planName === "string") lot.planName = v.planName;
  return lot;
}

function readPlan(v: unknown): Wallet["plan"] | null {
  if (!isObj(v) || typeof v.tier !== "string" || !isObj(v.caps)) return null;
  if (v.walletPlan !== null && !oneOf(v.walletPlan, WALLET_PLANS)) return null;
  const { accounts, brands, queued } = v.caps;
  if (!isCount(accounts) || !isCountOrNull(brands) || !isCountOrNull(queued)) return null;
  return { tier: v.tier, walletPlan: v.walletPlan, caps: { accounts, brands: brands as number | null, queued: queued as number | null } };
}

function readNextExpiry(v: unknown): Wallet["nextExpiry"] | undefined {
  if (v === null) return null;
  return isObj(v) && isDateText(v.at) && isCount(v.credits) ? { at: v.at, credits: v.credits } : undefined;
}

function readWallet(v: unknown): Wallet | null {
  if (!isObj(v) || typeof v.exempt !== "boolean" || !isCount(v.balance) || !isCount(v.held) || typeof v.paused !== "boolean") return null;
  if (!Array.isArray(v.lots) || !isObj(v.prices) || !isCount(v.prices.post_publish) || !isCount(v.prices.competitor_teardown)) return null;
  const lots = v.lots.map(readLot);
  const plan = readPlan(v.plan);
  const nextExpiry = readNextExpiry(v.nextExpiry);
  if (lots.some((l) => l === null) || !plan || nextExpiry === undefined) return null;
  const prices = { post_publish: v.prices.post_publish, competitor_teardown: v.prices.competitor_teardown };
  return { exempt: v.exempt, balance: v.balance, held: v.held, lots: lots as CreditLot[], nextExpiry, paused: v.paused, plan, prices };
}

function readItem(v: unknown): CatalogItem | null {
  if (!isObj(v) || typeof v.sku !== "string" || v.sku === "" || typeof v.name !== "string") return null;
  if (!oneOf(v.kind, ["pack", "subscription"] as const) || !isCount(v.priceCents) || !isCount(v.credits)) return null;
  if (typeof v.expires !== "boolean" || !oneOf(v.interval, ["one_time", "month"] as const) || typeof v.purchasable !== "boolean") return null;
  if (v.requiresPlan !== null && typeof v.requiresPlan !== "string") return null;
  if (v.reason !== null && !oneOf(v.reason, REASONS)) return null;
  return {
    sku: v.sku, name: v.name, kind: v.kind, priceCents: v.priceCents, credits: v.credits, expires: v.expires,
    interval: v.interval, requiresPlan: v.requiresPlan, purchasable: v.purchasable, reason: v.reason,
  };
}

function readCatalog(v: unknown): CatalogItem[] | null {
  if (!isObj(v) || !Array.isArray(v.items)) return null;
  const items = v.items.map(readItem);
  return items.some((i) => i === null) ? null : (items as CatalogItem[]);
}

const statusOf = (e: unknown): number | undefined => (isObj(e) && typeof e.status === "number" ? e.status : undefined);

/** Plain words for a failed read. 401 or a missing session asks for a fresh sign-in; anything else is a try-again line. */
function friendly(e: unknown, tryAgain: string): string {
  const signedOut = statusOf(e) === 401 || (e instanceof Error && e.message === "Not signed in");
  return signedOut ? "Please sign in again to see your credits." : tryAgain;
}

export async function getBalance(fetcher: Fetcher = authedFetch): Promise<BalanceResult> {
  try {
    const wallet = readWallet(await fetcher("/wallet/balance"));
    return wallet ? { kind: "ok", wallet } : { kind: "unavailable" };
  } catch (cause) {
    if (statusOf(cause) === 404) return { kind: "unavailable" };
    return { kind: "error", message: friendly(cause, "We could not load your credits just now. Please try again."), cause };
  }
}

export async function getCatalog(fetcher: Fetcher = authedFetch): Promise<CatalogResult> {
  try {
    const items = readCatalog(await fetcher("/wallet/catalog"));
    return items ? { kind: "ok", items } : { kind: "unavailable" };
  } catch (cause) {
    if (statusOf(cause) === 404) return { kind: "unavailable" };
    return { kind: "error", message: friendly(cause, "We could not load the credit options just now. Please try again."), cause };
  }
}
