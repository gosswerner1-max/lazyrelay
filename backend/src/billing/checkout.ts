import { isSku } from "../wallet/catalog.js";
import type { CheckoutPort } from "../wallet/checkoutPort.js";
import { SKU_PRICE_ENV_VARS, priceIdForSku, walletPlanForSku } from "./skuPrices.js";

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

/** The account's authenticated, confirmed email, or null when there is none. A failed read must throw, never return null. */
export type EmailForAccount = (accountId: string) => Promise<string | null>;

function parseJson(raw: string, status: number): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Paddle answered ${status} with a body that is not JSON: ${raw.slice(0, 300)}`);
  }
}

export function createPaddleCheckoutPort(opts: { apiKey: string | undefined; http?: PaddleHttpClient; env?: Env; emailForAccount?: EmailForAccount }): CheckoutPort {
  const env = opts.env ?? process.env;
  if (!opts.apiKey) throw new Error("MOR_API_KEY is not set; the Paddle checkout cannot be created");
  const apiKey = opts.apiKey;
  const http: PaddleHttpClient = opts.http ?? ((url, init) => fetch(url, init));
  const baseUrl = env.PADDLE_ENVIRONMENT === "production" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";

  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  async function paddleCustomerId(email: string): Promise<string> {
    const lookup = await http(`${baseUrl}/customers?email=${encodeURIComponent(email)}`, { method: "GET", headers, body: "" });
    const lookupRaw = await lookup.text();
    if (!lookup.ok) throw new Error(`Paddle refused the customer lookup: HTTP ${lookup.status} ${lookupRaw}`);
    const existing = (parseJson(lookupRaw, lookup.status) as { data?: Array<{ id?: unknown }> }).data?.[0]?.id;
    if (typeof existing === "string" && existing) return existing;

    const create = await http(`${baseUrl}/customers`, { method: "POST", headers, body: JSON.stringify({ email }) });
    const createRaw = await create.text();
    if (!create.ok) throw new Error(`Paddle refused the customer: HTTP ${create.status} ${createRaw}`);
    const created = (parseJson(createRaw, create.status) as { data?: { id?: unknown } }).data?.id;
    if (typeof created !== "string" || !created) throw new Error(`Paddle answered without a customer id: ${createRaw.slice(0, 300)}`);
    return created;
  }

  return {
    async createCheckout(accountId, sku, checkoutOpts) {
      if (!isSku(sku)) throw new Error(`unknown sku "${String(sku)}"`);
      if (typeof accountId !== "string" || !UUID.test(accountId)) throw new Error("the account id is not valid");
      const priceId = priceIdForSku(sku, env);
      if (!priceId) throw new Error(`no Paddle price id is configured for ${sku}; set ${SKU_PRICE_ENV_VARS[sku]}`);

      // With a known email the checkout frame shows it. No email known: no customer, exactly as before. A failure here is raised, never skipped.
      const email = opts.emailForAccount ? await opts.emailForAccount(accountId) : null;
      const customerId = email ? await paddleCustomerId(email) : null;

      // Partner viewer discount: ONE shared Paddle discount (10%, first payment only, restricted to the Growth and Pro prices on the Paddle
      // side), applied only to a plan, only with a partner code the server already validated, and only when its id is configured.
      const discountId = checkoutOpts?.partnerCode && walletPlanForSku(sku) && env.PADDLE_PARTNER_DISCOUNT_ID ? env.PADDLE_PARTNER_DISCOUNT_ID : undefined;

      const response = await http(`${baseUrl}/transactions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          items: [{ price_id: priceId, quantity: 1 }],
          ...(customerId ? { customer_id: customerId } : {}),
          custom_data: { account_id: accountId, sku, ...(checkoutOpts?.partnerCode ? { partnerCode: checkoutOpts.partnerCode } : {}) },
          ...(discountId ? { discount_id: discountId } : {}),
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
      return { checkoutUrl, transactionId, ...(discountId ? { discountApplied: true } : {}) };
    },
  };
}
