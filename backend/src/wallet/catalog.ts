/**
 * The pack and plan catalog as LOCAL STAGING DATA. Nothing reads it yet and no Paddle product exists (paddlePriceId stays null). The
 * database holds the same rows in wallet_packs (migration 0140) and is the one that grants; a test catches the two drifting apart.
 * Money is whole cents. A pack is a one time purchase; a subscription lot expires at the period end. requiresPlan gates a SKU to an
 * active plan: the webhook handler (later) supplies the plan to wallet_grant_for_sku.
 */
export type SkuKind = "pack" | "subscription";

export interface CatalogEntry {
  sku: string;
  name: string;
  kind: SkuKind;
  priceCents: number;
  credits: number;
  expires: boolean;
  interval: "one_time" | "month";
  requiresPlan: string | null;
  paddlePriceId: string | null;
  active: boolean;
  description: string;
}

export const SKU = {
  starterPack: "lazycredits-starter-pack",
  growthPack: "lazycredits-growth-pack",
  proTopUp: "lazycredits-pro-top-up",
  growthPlan: "lazyrelay-growth-plan",
  proPlan: "lazyrelay-pro-plan",
} as const;

export type SkuId = (typeof SKU)[keyof typeof SKU];

export const CATALOG: Record<SkuId, CatalogEntry> = {
  [SKU.starterPack]: {
    sku: SKU.starterPack, name: "LazyCredits Starter Pack", kind: "pack", priceCents: 1500, credits: 300, expires: false, interval: "one_time", requiresPlan: null, paddlePriceId: null, active: true,
    description: "300 universal credits for multi-channel post distribution and deep competitor market analysis teardowns. Credits never expire.",
  },
  [SKU.growthPack]: {
    sku: SKU.growthPack, name: "LazyCredits Growth Pack", kind: "pack", priceCents: 5000, credits: 1500, expires: false, interval: "one_time", requiresPlan: null, paddlePriceId: null, active: true,
    description: "1,500 universal credits optimized for scaling brands running high-frequency distribution cadences. Credits never expire.",
  },
  [SKU.proTopUp]: {
    sku: SKU.proTopUp, name: "LazyCredits Pro Top-Up", kind: "pack", priceCents: 3000, credits: 1500, expires: false, interval: "one_time", requiresPlan: "pro", paddlePriceId: null, active: true,
    description: "1,500 universal credits available exclusively for active Pro Tier subscribers. Credits never expire.",
  },
  [SKU.growthPlan]: {
    sku: SKU.growthPlan, name: "LazyRelay Growth Plan", kind: "subscription", priceCents: 2900, credits: 1000, expires: true, interval: "month", requiresPlan: null, paddlePriceId: null, active: true,
    description: "Includes 1,000 universal monthly credits, 30 connected social accounts, and 4 distinct brand profiles.",
  },
  [SKU.proPlan]: {
    sku: SKU.proPlan, name: "LazyRelay Pro Plan", kind: "subscription", priceCents: 9900, credits: 6000, expires: true, interval: "month", requiresPlan: null, paddlePriceId: null, active: true,
    description: "Includes 6,000 universal monthly credits, unlimited brand profiles, and high-volume agency scheduling limits up to 1,000 connected accounts.",
  },
};

export const SKU_LIST: CatalogEntry[] = Object.values(CATALOG);

export function isSku(value: unknown): value is SkuId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CATALOG, value);
}

/** Price per credit in cents, to 4 decimals: the Starter Pack is 5, the Growth Pack 3.3333, the Pro Plan 1.65. */
export function centsPerCredit(sku: SkuId): number {
  const entry = CATALOG[sku];
  return Math.round((entry.priceCents * 10_000) / entry.credits) / 10_000;
}
