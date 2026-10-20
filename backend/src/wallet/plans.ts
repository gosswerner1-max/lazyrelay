/**
 * The plans as data. NOTHING READS THIS yet: it changes no live tier, price, limit or page. Money is whole cents, credits are whole
 * credits, `null` means unlimited (or not set). The payg and growth caps equal the live Starter and Pro tables (ACCOUNT_LIMITS and
 * BRAND_LIMITS), so enforcement can later reuse those.
 */
export const PLAN_IDS = ["free", "payg", "growth", "pro"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanData {
  id: PlanId;
  priceCents: number;
  cadence: "none" | "one_time" | "month";
  credits: number;
  creditsExpire: boolean;
  /** True when the credits are given once at registration (no monthly reset). */
  grantedOnce: boolean;
  maxAccounts: number;
  maxBrands: number | null;
  maxQueuedPosts: number | null;
}

export const PLANS: Record<PlanId, PlanData> = {
  free: { id: "free", priceCents: 0, cadence: "none", credits: 30, creditsExpire: false, grantedOnce: true, maxAccounts: 3, maxBrands: 1, maxQueuedPosts: 10 },
  payg: { id: "payg", priceCents: 1500, cadence: "one_time", credits: 300, creditsExpire: false, grantedOnce: false, maxAccounts: 20, maxBrands: 2, maxQueuedPosts: null },
  growth: { id: "growth", priceCents: 2900, cadence: "month", credits: 1000, creditsExpire: true, grantedOnce: false, maxAccounts: 30, maxBrands: 4, maxQueuedPosts: null },
  pro: { id: "pro", priceCents: 9900, cadence: "month", credits: 6000, creditsExpire: true, grantedOnce: false, maxAccounts: 1000, maxBrands: null, maxQueuedPosts: null },
};
