import { Router } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { supabase } from "../supabase.js";
import { cancelSubscription } from "../billing/sync.js";
import { buildCheckoutTransaction } from "../billing/paddle.js";
import { Environment } from "@paddle/paddle-node-sdk";
import type { MerchantOfRecordAdapter } from "../billing/types.js";
import type { PlatformAdapter } from "../platforms/types.js";
import { startConnect, completeConnect } from "../platforms/connect.js";
import { requireAuth, type AuthedRequest } from "./auth.js";

// Free tier: 10 posts per connected social account, refilling every
// calendar month (decided 2026-07-22 — matches the pricing page's "10 posts
// per account, refillable" copy, which had no enforcement until now).
const FREE_TIER_MONTHLY_POSTS_PER_ACCOUNT = 10;

// Post media (images/video attached to a scheduled post) — uploaded via
// multipart form data, held in memory only long enough to forward the
// buffer to Supabase Storage's "post-media" bucket (see migration
// 0007_post_media_bucket.sql). 20MB covers a real photo/short clip without
// letting someone upload something absurd through this endpoint.
const MEDIA_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_MEDIA_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
]);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MEDIA_UPLOAD_MAX_BYTES } });

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

  // Uploads a single image/video for use as a scheduled post's media_url.
  // Goes through our own service-role Supabase client, not the browser
  // directly — customers never touch storage credentials, and this is
  // where mime-type/size validation actually gets enforced server-side.
  router.post("/media/upload", requireAuth, upload.single("file"), async (req: AuthedRequest, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded (expected multipart field \"file\")" });
      return;
    }
    if (!ALLOWED_MEDIA_MIME_TYPES.has(file.mimetype)) {
      res.status(400).json({ error: `Unsupported file type "${file.mimetype}" — use an image (jpeg/png/webp/gif) or video (mp4/mov)` });
      return;
    }

    const extension = file.originalname.includes(".") ? file.originalname.split(".").pop() : "bin";
    const path = `${req.accountId}/${randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage
      .from("post-media")
      .upload(path, file.buffer, { contentType: file.mimetype });
    if (uploadError) {
      res.status(500).json({ error: uploadError.message });
      return;
    }

    const { data } = supabase.storage.from("post-media").getPublicUrl(path);
    res.status(201).json({ url: data.publicUrl });
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

    // Free tier: 10 posts per connected account per calendar month. Paid
    // tiers (Pro/Business) in good standing (active or trialing) are
    // unlimited; past_due/cancelled/no-subscription all fall back to the
    // free limit — a lapsed payment shouldn't keep unlimited posting.
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("tier, status")
      .eq("account_id", req.accountId)
      .maybeSingle();
    const isPaidInGoodStanding = sub?.tier !== "free" && (sub?.status === "active" || sub?.status === "trialing");
    if (!isPaidInGoodStanding) {
      const now = new Date();
      const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      const { count, error: countError } = await supabase
        .from("scheduled_posts")
        .select("id", { count: "exact", head: true })
        .eq("social_account_id", socialAccountId)
        .gte("created_at", startOfMonth);
      if (countError) {
        res.status(500).json({ error: countError.message });
        return;
      }
      if ((count ?? 0) >= FREE_TIER_MONTHLY_POSTS_PER_ACCOUNT) {
        res.status(403).json({
          error: `Free tier limit reached: ${FREE_TIER_MONTHLY_POSTS_PER_ACCOUNT} posts per connected account per month. Upgrade to Pro for unlimited posts, or wait until next month.`,
        });
        return;
      }
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

  // Reports the caller's current tier/status — "free" with no status when
  // no subscription row exists yet (a fresh signup before ever upgrading),
  // which is a normal state, not an error.
  router.get("/subscription", requireAuth, async (req: AuthedRequest, res) => {
    const { data: sub, error } = await supabase
      .from("subscriptions")
      .select("tier, status, current_period_end")
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    if (!sub) {
      res.json({ tier: "free", status: null, currentPeriodEnd: null });
      return;
    }
    res.json({ tier: sub.tier, status: sub.status, currentPeriodEnd: sub.current_period_end });
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
      const { transactionId, checkoutUrl } = await buildCheckoutTransaction(apiKey, environment, {
        accountEmail: account.email,
        tier,
        priceId,
      });
      res.json({ transactionId, checkoutUrl });
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
