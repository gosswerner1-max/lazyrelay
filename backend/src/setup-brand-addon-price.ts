import "dotenv/config";
import { Paddle, Environment } from "@paddle/paddle-node-sdk";

// One-off setup script — creates the single brand add-on Paddle price
// (Phase 1b, 2026-08-16), on its own dedicated product, same pattern as
// setup-storage-addon-prices.ts. Unlike storage (three sizes), a brand
// add-on is one flat +1-slot price: $10.00/mo, anchored to SocialBee's own
// $10/workspace add-on and Later's $11.25/social-set add-on (see the
// competitor research in the vault, project-brand-cap-agency-tier-2026-08-16).
//
// NOT run automatically — creates a real, live-chargeable Paddle
// product/price when PADDLE_ENVIRONMENT=production. Run manually, once,
// with Werner's explicit go-ahead, then copy the printed price id into
// backend/.env and Render's env vars as PADDLE_PRICE_ID_BRAND_ADDON.

async function main() {
  const apiKey = process.env.MOR_API_KEY;
  if (!apiKey) throw new Error("MOR_API_KEY not set");
  const environment = process.env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox;
  const paddle = new Paddle(apiKey, { environment });

  const product = await paddle.products.create({
    name: "LazyRelay Brand Add-on",
    taxCategory: "saas",
    description: "One extra brand slot on top of a LazyRelay subscription plan's included brand count (Starter/Pro/Business only).",
  });
  console.log("Created brand add-on product:", product.id);

  const price = await paddle.prices.create({
    description: "LazyRelay +1 brand add-on — $10.00/mo",
    productId: product.id,
    unitPrice: { amount: "1000", currencyCode: "USD" },
    billingCycle: { interval: "month", frequency: 1 },
  });
  console.log("Created +1 brand price:", price.id, price.unitPrice.amount);

  console.log("\n--- Set this in .env (and Render's env vars) ---");
  console.log(`PADDLE_PRICE_ID_BRAND_ADDON=${price.id}`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
