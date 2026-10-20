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
