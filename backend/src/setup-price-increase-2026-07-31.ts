import "dotenv/config";
import { Paddle, Environment } from "@paddle/paddle-node-sdk";

// One-off setup script for the 2026-07-31 price increase (Starter $24.99→
// $29.99, Pro $48.99→$59.99, Business $79.99→$99.99), following the new
// feature set (analytics, AI captions/hashtags, calendar, bulk import,
// approval workflow, link-in-bio, social listening, browser extension)
// shipped the same day. Same pattern as setup-new-tier-prices.ts: Paddle
// prices are immutable, so this creates NEW price objects on the EXISTING
// products rather than editing anything — existing subscribers stay on
// their current price automatically (Paddle doesn't retroactively reprice
// an active subscription just because a new Price object exists for the
// same product); only new checkouts pick up the new price IDs once the env
// vars below are updated. Prints the new price IDs to set as env vars.

async function main() {
  const apiKey = process.env.MOR_API_KEY;
  if (!apiKey) throw new Error("MOR_API_KEY not set");
  const environment = process.env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox;
  const paddle = new Paddle(apiKey, { environment });

  const tiers = [
    { name: "Starter", envVar: "PADDLE_PRICE_ID_STARTER", newAmount: "2999", label: "$29.99/mo" },
    { name: "Pro", envVar: "PADDLE_PRICE_ID_PRO", newAmount: "5999", label: "$59.99/mo" },
    { name: "Business", envVar: "PADDLE_PRICE_ID_BUSINESS", newAmount: "9999", label: "$99.99/mo" },
  ];

  const results: Record<string, string> = {};

  for (const tier of tiers) {
    const oldPriceId = process.env[tier.envVar];
    if (!oldPriceId) throw new Error(`${tier.envVar} not set`);

    const oldPrice = await paddle.prices.get(oldPriceId);
    console.log(`${tier.name} — existing product ${oldPrice.productId}, current amount ${oldPrice.unitPrice.amount}`);

    const newPrice = await paddle.prices.create({
      description: `LazyRelay ${tier.name} — ${tier.label} (2026-07-31 price increase)`,
      productId: oldPrice.productId,
      unitPrice: { amount: tier.newAmount, currencyCode: "USD" },
      billingCycle: { interval: "month", frequency: 1 },
    });
    console.log(`Created new ${tier.name} price:`, newPrice.id, newPrice.unitPrice.amount);
    results[tier.envVar] = newPrice.id;
  }

  console.log("\n--- Set these in .env / Render env vars ---");
  for (const tier of tiers) {
    console.log(`${tier.envVar}=${results[tier.envVar]}`);
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
