import "dotenv/config";
import { Paddle, Environment } from "@paddle/paddle-node-sdk";

// One-off setup script — creates the three storage add-on Paddle prices
// (2026-07-23), on their own dedicated product (distinct from the tier
// products, since these are a genuinely different thing being sold).
// Pricing rationale (see routes.ts's STORAGE_ADDON_GB_OPTIONS comment):
// declining $/GB per block, 20-40x markup over the $0.015/GB raw R2 cost —
// deliberate convenience pricing on top of an already-paid subscription.

async function main() {
  const apiKey = process.env.MOR_API_KEY;
  if (!apiKey) throw new Error("MOR_API_KEY not set");
  const environment = process.env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox;
  const paddle = new Paddle(apiKey, { environment });

  const product = await paddle.products.create({
    name: "LazyRelay Storage Add-on",
    taxCategory: "saas",
    description: "Extra media storage on top of a LazyRelay subscription plan (Starter/Pro/Business only).",
  });
  console.log("Created storage add-on product:", product.id);

  const tiers = [
    { gb: 5, amountCents: "299" },
    { gb: 20, amountCents: "799" },
    { gb: 50, amountCents: "1499" },
  ];

  const results: Record<string, string> = {};
  for (const tier of tiers) {
    const price = await paddle.prices.create({
      description: `LazyRelay +${tier.gb}GB storage add-on — $${(Number(tier.amountCents) / 100).toFixed(2)}/mo`,
      productId: product.id,
      unitPrice: { amount: tier.amountCents, currencyCode: "USD" },
      billingCycle: { interval: "month", frequency: 1 },
    });
    console.log(`Created +${tier.gb}GB price:`, price.id, price.unitPrice.amount);
    results[`PADDLE_PRICE_ID_STORAGE_${tier.gb}GB`] = price.id;
  }

  console.log("\n--- Set these in .env ---");
  for (const [key, value] of Object.entries(results)) {
    console.log(`${key}=${value}`);
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
