import { isSku } from "../wallet/catalog.js";
import type { CheckoutPort } from "../wallet/checkoutPort.js";
import { SKU_PRICE_ENV_VARS, priceIdForSku } from "./skuPrices.js";

// Server created Paddle transactions for the LazyCredits packs and plans. The account id goes into the transaction's custom data HERE, on
// the server: a browser supplied account id would be forgeable. Transactions DO echo their custom data on the webhook (a price's own
// custom data does not), which is how the webhook knows whose payment it is. The sku itself is taken from the price id on the webhook.
//
// The HTTP client is injected so tests use a fake and never reach Paddle. Raw failures are thrown with the status and Paddle's own words;
// the API key is never put in a message.

export interface PaddleHttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type PaddleHttpClient = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<PaddleHttpResponse>;

type Env = Record<string, string | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Where Paddle returns the customer after checkout; the same page the old tier checkout uses. */
const RETURN_URL = "https://lazyrelay.com";

export function createPaddleCheckoutPort(opts: { apiKey: string | undefined; http?: PaddleHttpClient; env?: Env }): CheckoutPort {
  const env = opts.env ?? process.env;
  if (!opts.apiKey) throw new Error("MOR_API_KEY is not set; the Paddle checkout cannot be created");
  const apiKey = opts.apiKey;
  const http: PaddleHttpClient = opts.http ?? ((url, init) => fetch(url, init));
  const baseUrl = env.PADDLE_ENVIRONMENT === "production" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";

  return {
    async createCheckout(accountId, sku) {
      if (!isSku(sku)) throw new Error(`unknown sku "${String(sku)}"`);
      if (typeof accountId !== "string" || !UUID.test(accountId)) throw new Error("the account id is not valid");
      const priceId = priceIdForSku(sku, env);
      if (!priceId) throw new Error(`no Paddle price id is configured for ${sku}; set ${SKU_PRICE_ENV_VARS[sku]}`);

      const response = await http(`${baseUrl}/transactions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ price_id: priceId, quantity: 1 }],
          custom_data: { account_id: accountId, sku },
          checkout: { url: RETURN_URL },
        }),
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`Paddle refused the transaction for ${sku}: HTTP ${response.status} ${raw}`);

      let parsed: { data?: { id?: unknown; checkout?: { url?: unknown } | null } };
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Paddle answered ${response.status} with a body that is not JSON: ${raw.slice(0, 300)}`);
      }
      const transactionId = parsed.data?.id;
      const checkoutUrl = parsed.data?.checkout?.url;
      if (typeof transactionId !== "string" || !transactionId) throw new Error(`Paddle answered without a transaction id: ${raw.slice(0, 300)}`);
      if (typeof checkoutUrl !== "string" || !checkoutUrl) throw new Error(`Paddle answered without a checkout url for ${transactionId}`);
      return { checkoutUrl, transactionId };
    },
  };
}
