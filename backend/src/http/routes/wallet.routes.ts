// The wallet API, mounted at /api/wallet. Everything sits behind the wallet switch: while WALLET_ENABLED is not exactly "true" every
// route answers like a route that does not exist (404), so the feature is invisible and nothing else changes.
//   GET  /wallet/balance          credits by lot kind, display figure, next expiry, open holds (signed in account only)
//   GET  /wallet/catalog          the sellable packs and plans, every amount as "plus tax" data
//   POST /wallet/checkout-intent  validates a SKU (Pro only gate), then asks the checkout port (package C, Paddle) for the checkout
//   POST /wallet/teardown         competitor teardown: hold, engine call with a server only token, commit or release
// The account always comes from the login, never from the request body.

import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth, requireHumanAuth, requireOwner, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { supabase } from "../../supabase.js";
import { resolveTier, type Tier } from "../../tier.js";
import { walletEnabled } from "../../wallet/flags.js";
import { walletMode } from "../../wallet/mode.js";
import { toWalletContract } from "../../wallet/balanceContract.js";
import { buildCatalogView, buildCheckoutIntent, type PackRow } from "../../wallet/checkout.js";
import { getCheckoutPort, type CheckoutPort } from "../../wallet/checkoutPort.js";
import { partnerDiscountConfigured, resolveApprovedPartnerCode } from "../../billing/partnerCode.js";
import { createEngineClient } from "../../wallet/engineClient.js";
import { createWalletLedger } from "../../wallet/ledger.js";
import { isLegacyAccount } from "../../wallet/legacy.js";
import { getWalletService, type WalletService } from "../../wallet/service.js";
import { runTeardown, type TeardownInput, type TeardownOutcome } from "../../wallet/teardown.js";

// 1 to 100 characters; the ledger adds a "teardown:" prefix and allows 128 in all.
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_.\-]{1,100}$/;
const MAX_INPUT_CHARS = 2048;

export interface WalletRouterDeps {
  service?: Pick<WalletService, "getBalance">;
  runTeardown?: (input: TeardownInput) => Promise<TeardownOutcome>;
  getTier?: (accountId: string) => Promise<Tier>;
  isLegacy?: (accountId: string) => Promise<boolean>;
  isCancelPending?: (accountId: string) => Promise<boolean>;
  readPacks?: () => Promise<PackRow[]>;
  /** Pass null to say "no checkout is wired". Left out, the port package C registered is used. */
  checkout?: CheckoutPort | null;
  /** Affiliate code check for the checkout. Returns the approved partner's real code or null; may throw (treated as no code). */
  resolvePartnerCode?: (code: unknown, accountId?: string) => Promise<string | null>;
  /** Whether the shared partner discount is set up (env PADDLE_PARTNER_DISCOUNT_ID). Only used to tell the screen what to promise. */
  discountConfigured?: () => boolean;
}

/** True when the account's subscription is scheduled to end at the period end (subscriptions.cancel_at_period_end, kept by billing sync). */
async function readCancelPending(accountId: string): Promise<boolean> {
  const { data, error } = await supabase.from("subscriptions").select("cancel_at_period_end").eq("account_id", accountId).maybeSingle();
  if (error) throw new Error(`cancel flag read failed: ${error.message}`);
  return data?.cancel_at_period_end === true;
}

async function readPacksFromDatabase(): Promise<PackRow[]> {
  const { data, error } = await supabase.from("wallet_packs").select("sku, name, kind, price_cents, credits, expires, interval, requires_plan, active");
  if (error) throw new Error(`wallet packs read failed: ${error.message}`);
  return (data ?? []) as PackRow[];
}

function realTeardown(input: TeardownInput): Promise<TeardownOutcome> {
  return runTeardown({ ledger: createWalletLedger(supabase as never), isLegacy: isLegacyAccount, engine: createEngineClient() }, input);
}

function unavailable(res: Response, what: string, err: unknown): void {
  console.error(`[wallet] ${what} failed:`, err);
  res.status(503).json({ error: "wallet_unavailable" });
}

export function buildWalletRouter(deps: WalletRouterDeps = {}): Router {
  const router = Router();
  const service = () => deps.service ?? getWalletService();
  const teardown = deps.runTeardown ?? realTeardown;
  const getTier = deps.getTier ?? resolveTier;
  const readPacks = deps.readPacks ?? readPacksFromDatabase;
  const isLegacy = deps.isLegacy ?? isLegacyAccount;
  const isCancelPending = deps.isCancelPending ?? readCancelPending;
  const resolvePartnerCode = deps.resolvePartnerCode ?? resolveApprovedPartnerCode;
  const discountConfigured = deps.discountConfigured ?? (() => partnerDiscountConfigured());
  const checkoutPort = () => ("checkout" in deps ? deps.checkout ?? null : getCheckoutPort());

  // Switched off: hand the request to whatever comes after this router, which has no such route.
  router.use((_req: Request, _res: Response, next: NextFunction) => (walletEnabled() ? next() : next("router")));

  router.get("/balance", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    try {
      const accountId = req.accountId as string;
      const [view, tier, legacy, cancelPending] = await Promise.all([service().getBalance(accountId), getTier(accountId), isLegacy(accountId), isCancelPending(accountId)]);
      res.json(toWalletContract(view, { tier, legacy, cancelPending, walletOn: walletMode() === "on" }));
    } catch (err) {
      unavailable(res, "balance", err);
    }
  });

  router.get("/catalog", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    try {
      const accountId = req.accountId as string;
      const [rows, tier, legacy, cancelPending] = await Promise.all([readPacks(), getTier(accountId), isLegacy(accountId), isCancelPending(accountId)]);
      res.json({ items: buildCatalogView(rows, { tier, legacy, cancelPending }) });
    } catch (err) {
      unavailable(res, "catalog", err);
    }
  });

  // Money moves from here, so: a person (not an API key), and the account owner.
  router.post("/checkout-intent", requireAuth, requireHumanAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    try {
      const accountId = req.accountId as string;
      const body = req.body as { sku?: unknown; partnerCode?: unknown } | undefined;
      const built = buildCheckoutIntent(body?.sku, await getTier(accountId));
      if (!built.ok) {
        const { status, ...body } = built;
        res.status(status).json(body);
        return;
      }
      const port = checkoutPort();
      if (!port) {
        res.status(503).json({ error: "checkout_not_available" });
        return;
      }
      // An affiliate code that is unknown, paused, the buyer's own or cannot be checked is dropped quietly: it must never stop a purchase.
      // Only a code the buyer typed (or saw prefilled) in the box arrives here; an empty box counts as no code.
      const typed = typeof body?.partnerCode === "string" ? body.partnerCode.trim() : "";
      let partnerCode: string | null = null;
      if (typed) {
        try {
          partnerCode = await resolvePartnerCode(typed, accountId);
        } catch (err) {
          console.error("[wallet] partner code check failed, continuing without it:", err);
        }
      }
      const checkout = partnerCode ? await port.createCheckout(accountId, built.intent.sku, { partnerCode }) : await port.createCheckout(accountId, built.intent.sku);
      const discount = partnerCode !== null && Boolean((checkout as { discountApplied?: unknown } | null)?.discountApplied);
      // The website reads transactionId, checkoutUrl and sku at the top level; the nested checkout object stays for anything that read it.
      const flat = checkout as { transactionId?: unknown; checkoutUrl?: unknown } | null;
      res.json({
        intent: built.intent,
        checkout,
        ...(typeof flat?.transactionId === "string" ? { transactionId: flat.transactionId } : {}),
        ...(typeof flat?.checkoutUrl === "string" ? { checkoutUrl: flat.checkoutUrl } : {}),
        sku: built.intent.sku,
        partner: { status: partnerCode ? "applied" : typed ? "invalid" : "none", discount },
      });
    } catch (err) {
      unavailable(res, "checkout intent", err);
    }
  });

  // The code box on the payment screen. Says only whether the code is valid for THIS account (an unknown, paused or own code is not)
  // and whether the first month discount is on offer; never an error for a bad code. The checkout re-checks the code itself.
  router.post("/partner-code/check", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    try {
      const raw = (req.body as { code?: unknown } | undefined)?.code;
      let valid = false;
      try {
        valid = Boolean(typeof raw === "string" && raw.trim() && (await resolvePartnerCode(raw, req.accountId as string)));
      } catch (err) {
        console.error("[wallet] partner code check failed:", err);
      }
      res.json({ valid, discount: valid && discountConfigured() });
    } catch (err) {
      unavailable(res, "partner code check", err);
    }
  });

  // A person is needed because the engine token names the signed in user. The token itself never leaves the backend.
  router.post("/teardown", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const key = req.get("Idempotency-Key");
    if (key === undefined || !IDEMPOTENCY_KEY.test(key)) {
      res.status(400).json({ error: "idempotency_key_required", message: "Send an Idempotency-Key header of 1 to 100 letters, digits or : _ . - (one new key per confirmed click)." });
      return;
    }
    const input = (req.body as { input?: unknown } | undefined)?.input;
    if (typeof input !== "string" || input.trim() === "" || input.length > MAX_INPUT_CHARS) {
      res.status(400).json({ error: "invalid_request", message: "An address to analyze is required." });
      return;
    }
    try {
      const accountId = req.accountId as string;
      const out = await teardown({ accountId, userId: req.userId as string, tier: await getTier(accountId), idempotencyKey: key, input });
      res.status(out.status).json(out.body);
    } catch (err) {
      console.error("[wallet] teardown crashed:", err);
      res.status(500).json({ error: "teardown_failed" });
    }
  });

  return router;
}
