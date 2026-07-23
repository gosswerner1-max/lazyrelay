import "dotenv/config";
import { Paddle, Environment } from "@paddle/paddle-node-sdk";

// One-off setup script for the Starter/Pro/Business tier restructure
// (2026-07-23) — creates the two NEW Paddle prices needed:
//   - "Pro" (formerly "Business"): $48.99/mo, reusing the existing
//     product the old $49 price belonged to.
//   - "Business" (brand new top tier): $79.99/mo, on a brand new product.
// "Starter" needs no new price — it reuses the existing $24.99 price
// unchanged (PADDLE_PRICE_ID_PRO), just displayed under a new name.
// Prints the new price IDs to set as env vars.

async function main() {
  const apiKey = process.env.MOR_API_KEY;
  if (!apiKey) throw new Error("MOR_API_KEY not set");
  const environment = process.env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox;
  const paddle = new Paddle(apiKey, { environment });

  const oldBusinessPriceId = process.env.PADDLE_PRICE_ID_BUSINESS;
  if (!oldBusinessPriceId) throw new Error("PADDLE_PRICE_ID_BUSINESS not set");

  const oldBusinessPrice = await paddle.prices.get(oldBusinessPriceId);
  console.log("Existing $49 price's product:", oldBusinessPrice.productId, "| current amount:", oldBusinessPrice.unitPrice.amount);

  // New "Pro" price ($48.99/mo) — same product as the old $49 "Business" price.
  const proPrice = await paddle.prices.create({
    description: "LazyRelay Pro (40 accounts) — $48.99/mo",
    productId: oldBusinessPrice.productId,
    unitPrice: { amount: "4899", currencyCode: "USD" },
    billingCycle: { interval: "month", frequency: 1 },
  });
  console.log("Created Pro price:", proPrice.id, proPrice.unitPrice.amount);

  // New "Business" product + price ($79.99/mo) — genuinely new top tier.
  const businessProduct = await paddle.products.create({
    name: "LazyRelay Business",
    taxCategory: "saas",
    description: "LazyRelay Business plan — 100 connected accounts, priority support",
  });
  console.log("Created Business product:", businessProduct.id);

  const businessPrice = await paddle.prices.create({
    description: "LazyRelay Business (100 accounts) — $79.99/mo",
    productId: businessProduct.id,
    unitPrice: { amount: "7999", currencyCode: "USD" },
    billingCycle: { interval: "month", frequency: 1 },
  });
  console.log("Created Business price:", businessPrice.id, businessPrice.unitPrice.amount);

  console.log("\n--- Set these in .env ---");
  console.log(`PADDLE_PRICE_ID_STARTER=${process.env.PADDLE_PRICE_ID_PRO}`); // unchanged, reused
  console.log(`PADDLE_PRICE_ID_PRO=${proPrice.id}`);
  console.log(`PADDLE_PRICE_ID_BUSINESS=${businessPrice.id}`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
