// Test-only sample answers shaped like the wallet contract. Nothing in the app imports this file.

export const sampleBalance = () => ({
  exempt: false,
  balance: 1830,
  held: 5,
  lots: [
    { kind: "subscription", remaining: 1200, expiresAt: "2026-11-10T12:00:00Z", autoRenew: true, planName: "Pro" },
    { kind: "topup", remaining: 500, expiresAt: "2026-11-10T12:00:00Z", boundPlan: "pro" },
    { kind: "pack", remaining: 100, expiresAt: null },
    { kind: "signup", remaining: 30, expiresAt: null },
  ],
  nextExpiry: { at: "2026-11-10T12:00:00Z", credits: 1700 },
  paused: false,
  plan: { tier: "pro", walletPlan: "pro", caps: { accounts: 30, brands: null, queued: 200 } },
  prices: { post_publish: 1, competitor_teardown: 10 },
});

export const sampleCatalog = () => ({
  items: [
    { sku: "pack_small", name: "Credit Pack", kind: "pack", priceCents: 900, credits: 300, expires: false, interval: "one_time", requiresPlan: null, purchasable: true, reason: null },
    { sku: "pro_monthly", name: "Pro Plan", kind: "subscription", priceCents: 5999, credits: 1200, expires: true, interval: "month", requiresPlan: null, purchasable: true, reason: null },
    { sku: "pro_topup", name: "Pro Top-Up", kind: "pack", priceCents: 2500, credits: 500, expires: true, interval: "one_time", requiresPlan: "pro", purchasable: false, reason: "needs_pro" },
  ],
});

/** The exact JSON GET /wallet/catalog returned for a free account (live Growth Pack row: requires_plan growth), captured from buildCatalogView on 2026-10-23. */
export const routeCatalogFreeAccount = () => ({"items":[{"sku":"lazycredits-starter-pack","name":"LazyCredits Starter Pack","kind":"pack","priceCents":1500,"currency":"USD","taxNote":"plus tax","credits":300,"expires":false,"interval":"one_time","requiresPlan":null,"description":"300 universal credits for multi-channel post distribution and deep competitor market analysis teardowns. Credits never expire.","purchasable":true,"reason":null},{"sku":"lazycredits-growth-pack","name":"LazyCredits Growth Pack","kind":"pack","priceCents":5000,"currency":"USD","taxNote":"plus tax","credits":1500,"expires":true,"interval":"one_time","requiresPlan":"growth","description":"1,500 universal credits optimized for scaling brands running high-frequency distribution cadences. Credits never expire.","purchasable":false,"reason":"needs_growth"},{"sku":"lazycredits-pro-top-up","name":"LazyCredits Pro Top-Up","kind":"pack","priceCents":3000,"currency":"USD","taxNote":"plus tax","credits":1500,"expires":true,"interval":"one_time","requiresPlan":"pro","description":"1,500 universal credits available exclusively for active Pro Tier subscribers. Bound to active subscription status: credits expire if the subscription is canceled.","purchasable":false,"reason":"needs_pro"}]});
