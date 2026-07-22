import { Router } from "express";
import { supabase } from "../supabase.js";
import { cancelSubscription } from "../billing/sync.js";
import { buildCheckoutTransaction } from "../billing/paddle.js";
import { Environment } from "@paddle/paddle-node-sdk";
import type { MerchantOfRecordAdapter } from "../billing/types.js";
import type { PlatformAdapter } from "../platforms/types.js";
import { startConnect, completeConnect } from "../platforms/connect.js";
import { requireAuth, type AuthedRequest } from "./auth.js";

export function buildRouter(morAdapter: MerchantOfRecordAdapter, platformAdapter: PlatformAdapter): Router {
  const router = Router();

  // Starts the "connect your social account" flow — returns the URL the
  // frontend should redirect the user to. Real account identity comes from
  // the verified JWT; the callback below never has to trust anything the
  // browser sends except the opaque, one-time state token.
  router.get("/social-accounts/connect", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const url = await startConnect(req.accountId!, platformAdapter);
      res.json({ authorizeUrl: url });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The OAuth callback — NOT behind requireAuth, since the platform
  // redirects the browser here directly with no way to attach our JWT.
  // Identity/authorization instead comes entirely from the state token,
  // which was minted server-side for a specific account and can only be
  // used once (see platforms/connect.ts).
  router.get("/social-accounts/callback", async (req, res) => {
    const { code, state } = req.query;
    if (typeof code !== "string" || typeof state !== "string") {
      res.status(400).json({ error: "Missing code or state" });
      return;
    }
    try {
      const socialAccountId = await completeConnect(state, code, platformAdapter);
      res.json({ connected: true, socialAccountId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/social-accounts", requireAuth, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("social_accounts")
      .select("id, platform, platform_account_id, display_name, connected_at, disconnected_at")
      .eq("account_id", req.accountId)
      .is("disconnected_at", null);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json(data);
  });

  // Schedule a new post. account_id is taken from the verified JWT, never
  // from the request body — a client can't schedule a post as someone else
  // by passing a different account_id, since requireAuth already resolved
  // who's actually calling.
  router.post("/scheduled-posts", requireAuth, async (req: AuthedRequest, res) => {
    const { socialAccountId, content, mediaUrl, scheduledFor } = req.body ?? {};
    if (!socialAccountId || !content || !scheduledFor) {
      res.status(400).json({ error: "socialAccountId, content, and scheduledFor are required" });
      return;
    }

    // Confirm the social account actually belongs to this caller before
    // scheduling against it — RLS would also catch this at the DB layer,
    // but checking explicitly here gives a clean 403 instead of an opaque
    // insert failure.
    const { data: account, error: accountError } = await supabase
      .from("social_accounts")
      .select("id, account_id")
      .eq("id", socialAccountId)
      .single();
    if (accountError || !account || account.account_id !== req.accountId) {
      res.status(403).json({ error: "Social account not found or not owned by this caller" });
      return;
    }

    const { data, error } = await supabase
      .from("scheduled_posts")
      .insert({
        account_id: req.accountId,
        social_account_id: socialAccountId,
        content,
        media_url: mediaUrl ?? null,
        scheduled_for: scheduledFor,
      })
      .select()
      .single();
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(201).json(data);
  });

  router.get("/scheduled-posts", requireAuth, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("scheduled_posts")
      .select("*, post_results(*)")
      .eq("account_id", req.accountId)
      .order("scheduled_for", { ascending: true });
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json(data);
  });

  // A pending post can be deleted (cancelled before it goes out); one
  // already posting/posted/failed cannot — matches the pending-only DELETE
  // policy already enforced by RLS in 0001, checked here too for a clean
  // error message rather than a silent no-op delete.
  router.delete("/scheduled-posts/:id", requireAuth, async (req: AuthedRequest, res) => {
    const { error, count } = await supabase
      .from("scheduled_posts")
      .delete({ count: "exact" })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .eq("status", "pending");
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    if (count === 0) {
      res.status(404).json({ error: "Not found, not owned by this caller, or no longer pending" });
      return;
    }
    res.status(204).send();
  });

  // Starts a real Paddle checkout transaction for upgrading to a paid tier.
  // Only meaningful once MOR_API_KEY + the tier's price ID env vars exist
  // (see BILLING_KNOWLEDGE.md) — reports a clear error rather than a
  // confusing Paddle SDK exception if they don't.
  router.post("/subscription/checkout", requireAuth, async (req: AuthedRequest, res) => {
    const { tier } = req.body ?? {};
    if (tier !== "pro" && tier !== "business") {
      res.status(400).json({ error: 'tier must be "pro" or "business" (use the Free tier by just not upgrading)' });
      return;
    }

    const apiKey = process.env.MOR_API_KEY;
    const priceId = tier === "pro" ? process.env.PADDLE_PRICE_ID_PRO : process.env.PADDLE_PRICE_ID_BUSINESS;
    if (!apiKey || !priceId) {
      res.status(503).json({
        error: "Billing isn't live yet — no Paddle account/price configured. See BILLING_KNOWLEDGE.md.",
      });
      return;
    }

    const { data: account, error: accountError } = await supabase
      .from("accounts")
      .select("email")
      .eq("id", req.accountId)
      .single();
    if (accountError || !account) {
      res.status(404).json({ error: "Account not found" });
      return;
    }

    const environment = process.env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox;
    try {
      const { checkoutUrl } = await buildCheckoutTransaction(apiKey, environment, {
        accountEmail: account.email,
        tier,
        priceId,
      });
      res.json({ checkoutUrl });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The cancellation flow — this is THE trust-critical endpoint. Cancels
  // with the Merchant of Record first; only then does the local record
  // get marked cancelled. See billing/sync.ts for the full reasoning.
  router.post("/subscription/cancel", requireAuth, async (req: AuthedRequest, res) => {
    const result = await cancelSubscription(req.accountId!, morAdapter);
    if (!result.success) {
      res.status(502).json({ error: result.errorMessage ?? "Cancellation failed at the payment provider" });
      return;
    }
    res.json({ cancelled: true });
  });

  return router;
}
