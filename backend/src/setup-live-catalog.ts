import "dotenv/config";
import { Paddle, Environment } from "@paddle/paddle-node-sdk";

// One-off setup script — creates LazyRelay's full Paddle LIVE catalog from
// scratch (2026-07-23), mirroring the sandbox catalog exactly: Starter/Pro/
// Business tier prices + the 3 storage add-on prices. Live has no existing
// prices to reuse (unlike the sandbox tier-restructure script), so every
// product/price is created fresh here.
// Requires LIVE_MOR_API_KEY (not the sandbox MOR_API_KEY) in the environment.

async function main() {
  const apiKey = process.env.LIVE_MOR_API_KEY;
  if (!apiKey) throw new Error("LIVE_MOR_API_KEY not set");
  const paddle = new Paddle(apiKey, { environment: Environment.production });

  const starterProduct = await paddle.products.create({
    name: "LazyRelay Starter",
    taxCategory: "saas",
    description: "LazyRelay Starter plan — 10 connected accounts.",
  });
  const starterPrice = await paddle.prices.create({
    description: "LazyRelay Starter (10 accounts) — $24.99/mo",
    productId: starterProduct.id,
    unitPrice: { amount: "2499", currencyCode: "USD" },
    billingCycle: { interval: "month", frequency: 1 },
  });
  console.log("Created Starter product:", starterProduct.id, "price:", starterPrice.id);

  const proProduct = await paddle.products.create({
    name: "LazyRelay Pro",
    taxCategory: "saas",
    description: "LazyRelay Pro plan — 40 connected accounts.",
  });
  const proPrice = await paddle.prices.create({
    description: "LazyRelay Pro (40 accounts) — $48.99/mo",
    productId: proProduct.id,
    unitPrice: { amount: "4899", currencyCode: "USD" },
    billingCycle: { interval: "month", frequency: 1 },
  });
  console.log("Created Pro product:", proProduct.id, "price:", proPrice.id);

  const businessProduct = await paddle.products.create({
    name: "LazyRelay Business",
    taxCategory: "saas",
    description: "LazyRelay Business plan — 100 connected accounts, priority support",
  });
  const businessPrice = await paddle.prices.create({
    description: "LazyRelay Business (100 accounts) — $79.99/mo",
    productId: businessProduct.id,
    unitPrice: { amount: "7999", currencyCode: "USD" },
    billingCycle: { interval: "month", frequency: 1 },
  });
  console.log("Created Business product:", businessProduct.id, "price:", businessPrice.id);

  const storageProduct = await paddle.products.create({
    name: "LazyRelay Storage Add-on",
    taxCategory: "saas",
    description: "Extra media storage on top of a LazyRelay subscription plan (Starter/Pro/Business only).",
  });
  console.log("Created storage add-on product:", storageProduct.id);

  const tiers = [
    { gb: 5, amountCents: "299" },
    { gb: 20, amountCents: "799" },
    { gb: 50, amountCents: "1499" },
  ];
  const storagePriceIds: Record<string, string> = {};
  for (const tier of tiers) {
    const price = await paddle.prices.create({
      description: `LazyRelay +${tier.gb}GB storage add-on — $${(Number(tier.amountCents) / 100).toFixed(2)}/mo`,
      productId: storageProduct.id,
      unitPrice: { amount: tier.amountCents, currencyCode: "USD" },
      billingCycle: { interval: "month", frequency: 1 },
    });
    console.log(`Created +${tier.gb}GB price:`, price.id);
    storagePriceIds[`PADDLE_PRICE_ID_STORAGE_${tier.gb}GB`] = price.id;
  }

  console.log("\n--- LIVE price IDs (do not set these live in Render until ready to accept real payments) ---");
  console.log(`PADDLE_PRICE_ID_STARTER=${starterPrice.id}`);
  console.log(`PADDLE_PRICE_ID_PRO=${proPrice.id}`);
  console.log(`PADDLE_PRICE_ID_BUSINESS=${businessPrice.id}`);
  for (const [key, value] of Object.entries(storagePriceIds)) {
    console.log(`${key}=${value}`);
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
