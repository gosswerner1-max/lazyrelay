import { Router, type Response } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { imageSize } from "image-size";
import { supabase } from "../supabase.js";
import { cancelSubscription, cancelStorageAddon } from "../billing/sync.js";
import { buildCheckoutTransaction } from "../billing/paddle.js";
import { Environment } from "@paddle/paddle-node-sdk";
import type { MerchantOfRecordAdapter } from "../billing/types.js";
import type { PlatformAdapter } from "../platforms/types.js";
import { startConnect, completeConnect } from "../platforms/connect.js";
import { requireAuth, type AuthedRequest } from "./auth.js";
import { tieredRateLimit, publicRateLimit } from "./rateLimit.js";
import { validateMediaForPlatform, type Platform } from "../mediaLimits.js";
import { checkQuotaForNewUpload, getStorageUsage } from "../storageQuota.js";
import { checkAccountLimit } from "../accountLimits.js";
import { resolveTier, type Tier } from "../tier.js";

// Storage add-ons — priced 2026-07-23 after researching real comparables
// (consumer cloud storage clusters $0.005-0.02/GB/mo, the closest real B2B
// benchmark — Microsoft 365 extra storage — runs ~$0.20/GB/mo). Landed on a
// 20-40x markup over the $0.015/GB raw R2 cost: this is discretionary
// convenience pricing on top of an already-paid subscription, not a storage
// product competing on raw economics, so the margin is deliberate. Declining
// $/GB per tier (bigger block = better relative value) mirrors every real
// benchmark found and nudges toward the larger tier instead of repeat-buying
// the small one. Free tier cannot buy add-ons — someone needing more than
// 250MB should upgrade to a real tier first, which itself includes more
// storage; add-ons are for someone already paying who wants MORE than their
// tier's base amount (e.g. Starter + only 10 accounts, but heavy media use).
const STORAGE_ADDON_GB_OPTIONS = [5, 20, 50] as const;
type StorageAddonGb = (typeof STORAGE_ADDON_GB_OPTIONS)[number];
// Closes off unbounded stacking (a scripted retry loop or fat-fingered
// repeat-click spinning up dozens of subscriptions) without affecting any
// real customer — 5 add-ons is already up to +250GB on top of the tier's
// base quota, far beyond realistic single-account usage.
const MAX_ACTIVE_STORAGE_ADDONS = 5;
const ADDON_PRICE_ID_ENV_VAR: Record<StorageAddonGb, string> = {
  5: "PADDLE_PRICE_ID_STORAGE_5GB",
  20: "PADDLE_PRICE_ID_STORAGE_20GB",
  50: "PADDLE_PRICE_ID_STORAGE_50GB",
};

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
  "video/webm", // TikTok-supported format, not previously allowed here
]);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MEDIA_UPLOAD_MAX_BYTES } });

// A scheduled post's text content — generous enough for any real platform's
// limit (X's 280 chars is the tightest we support) while still capping
// unbounded input before it reaches the database.
const MAX_POST_CONTENT_LENGTH = 5000;

// Postgres/Supabase error messages can name internal detail (constraint
// names, column names, query shape) that shouldn't reach a customer. Log the
// real message server-side for debugging, return a generic one to the
// client. Use this for DB-layer errors; a message we wrote ourselves
// (validation, business-rule errors) should still be returned directly.
function dbError(res: Response, err: { message: string }, context: string): void {
  console.error(`[routes] ${context}:`, err.message);
  res.status(500).json({ error: "Something went wrong on our end. Please try again." });
}

export function buildRouter(morAdapter: MerchantOfRecordAdapter, platformAdapter: PlatformAdapter): Router {
  const router = Router();

  // Starts the "connect your social account" flow — returns the URL the
  // frontend should redirect the user to. Real account identity comes from
  // the verified JWT; the callback below never has to trust anything the
  // browser sends except the opaque, one-time state token.
  router.get("/social-accounts/connect", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    try {
      // Real per-tier cap, not just marketing copy — see accountLimits.ts
      // for why even the top tier is capped rather than truly unlimited.
      const limitError = await checkAccountLimit(req.accountId!);
      if (limitError) {
        res.status(403).json({ error: limitError });
        return;
      }
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
  router.get("/social-accounts/callback", publicRateLimit, async (req, res) => {
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

  router.get("/social-accounts", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("social_accounts")
      .select("id, platform, platform_account_id, display_name, connected_at, disconnected_at")
      .eq("account_id", req.accountId)
      .is("disconnected_at", null);
    if (error) {
      dbError(res, error, "GET /social-accounts");
      return;
    }
    res.json(data);
  });

  // Uploads a single image/video for use as a scheduled post's media_url.
  // Goes through our own service-role Supabase client, not the browser
  // directly — customers never touch storage credentials, and this is
  // where mime-type/size validation actually gets enforced server-side.
  router.post("/media/upload", requireAuth, tieredRateLimit, upload.single("file"), async (req: AuthedRequest, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded (expected multipart field \"file\")" });
      return;
    }
    if (!ALLOWED_MEDIA_MIME_TYPES.has(file.mimetype)) {
      res.status(400).json({ error: `Unsupported file type "${file.mimetype}" — use an image (jpeg/png/webp/gif) or video (mp4/mov)` });
      return;
    }

    // Per-account storage quota — the defense against the "upload media
    // forever, never attached to anything, for free" cost-abuse gap. We
    // never delete a customer's files ourselves; once they're at quota,
    // new uploads are rejected until they delete something or upgrade —
    // same model as any cloud storage gauge, not a notice-and-delete policy.
    const quotaError = await checkQuotaForNewUpload(req.accountId!, file.buffer.length);
    if (quotaError) {
      res.status(413).json({ error: quotaError });
      return;
    }

    const extension = file.originalname.includes(".") ? file.originalname.split(".").pop() : "bin";
    const path = `${req.accountId}/${randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage
      .from("post-media")
      .upload(path, file.buffer, { contentType: file.mimetype });
    if (uploadError) {
      dbError(res, uploadError, "POST /media/upload storage.upload");
      return;
    }

    const { data } = supabase.storage.from("post-media").getPublicUrl(path);

    // Measure real dimensions ourselves (images only — video needs ffprobe,
    // not added yet, see mediaLimits.ts) so /scheduled-posts can validate
    // against the TARGET platform's actual requirements later using
    // server-measured metadata, not anything a client could misreport.
    let width: number | null = null;
    let height: number | null = null;
    if (file.mimetype.startsWith("image/")) {
      try {
        const dims = imageSize(file.buffer);
        width = dims.width ?? null;
        height = dims.height ?? null;
      } catch {
        // Unreadable/corrupt image headers — leave dimensions null rather
        // than fail the upload; the platform itself will reject it later
        // if it's genuinely broken, and dimension checks just get skipped.
      }
    }

    const { error: metaError } = await supabase.from("media_uploads").insert({
      account_id: req.accountId,
      url: data.publicUrl,
      storage_path: path,
      mime_type: file.mimetype,
      size_bytes: file.buffer.length,
      width,
      height,
    });
    if (metaError) {
      dbError(res, metaError, "POST /media/upload media_uploads.insert");
      return;
    }

    res.status(201).json({ url: data.publicUrl });
  });

  // Storage gauge — used/quota bytes for the caller's account, same model
  // as any cloud-storage usage indicator. See storageQuota.ts.
  router.get("/media/usage", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    try {
      const usage = await getStorageUsage(req.accountId!);
      res.json(usage);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Lists the caller's own uploaded media, newest first — the "manage your
  // files" view a customer uses to find something to delete once they're
  // near quota.
  router.get("/media", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("media_uploads")
      .select("id, url, mime_type, size_bytes, width, height, created_at")
      .eq("account_id", req.accountId)
      .order("created_at", { ascending: false });
    if (error) {
      dbError(res, error, "GET /media");
      return;
    }
    res.json(data);
  });

  // Deletes a customer's own uploaded media — this is the ONLY way media
  // ever gets removed; LazyRelay never auto-deletes a customer's files.
  // Blocked if the file is still referenced by a pending/posting scheduled
  // post (checked via media_url match) so deleting storage out from under
  // an about-to-fire post can't silently break it.
  router.delete("/media/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: media, error: mediaError } = await supabase
      .from("media_uploads")
      .select("id, account_id, url, storage_path")
      .eq("id", req.params.id)
      .single();
    if (mediaError || !media || media.account_id !== req.accountId) {
      res.status(404).json({ error: "Media not found or not owned by this caller" });
      return;
    }

    const { count: inUseCount, error: inUseError } = await supabase
      .from("scheduled_posts")
      .select("id", { count: "exact", head: true })
      .eq("media_url", media.url)
      .in("status", ["pending", "posting"]);
    if (inUseError) {
      dbError(res, inUseError, "DELETE /media/:id scheduled_posts lookup");
      return;
    }
    if ((inUseCount ?? 0) > 0) {
      res.status(409).json({ error: "This file is attached to a post that hasn't gone out yet — cancel or wait for that post before deleting it." });
      return;
    }

    if (media.storage_path) {
      const { error: storageError } = await supabase.storage.from("post-media").remove([media.storage_path]);
      if (storageError) {
        dbError(res, storageError, "DELETE /media/:id storage.remove");
        return;
      }
    }

    const { error: deleteError } = await supabase.from("media_uploads").delete().eq("id", media.id);
    if (deleteError) {
      dbError(res, deleteError, "DELETE /media/:id media_uploads.delete");
      return;
    }

    res.status(204).send();
  });

  // Schedule a new post. account_id is taken from the verified JWT, never
  // from the request body — a client can't schedule a post as someone else
  // by passing a different account_id, since requireAuth already resolved
  // who's actually calling.
  router.post("/scheduled-posts", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { socialAccountId, content, mediaUrl, scheduledFor } = req.body ?? {};
    if (!socialAccountId || !content || !scheduledFor) {
      res.status(400).json({ error: "socialAccountId, content, and scheduledFor are required" });
      return;
    }
    if (typeof socialAccountId !== "string") {
      res.status(400).json({ error: "socialAccountId must be a string" });
      return;
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      res.status(400).json({ error: "content must be a non-empty string" });
      return;
    }
    if (content.length > MAX_POST_CONTENT_LENGTH) {
      res.status(400).json({ error: `content must be ${MAX_POST_CONTENT_LENGTH} characters or fewer` });
      return;
    }
    if (typeof scheduledFor !== "string") {
      res.status(400).json({ error: "scheduledFor must be an ISO date string" });
      return;
    }
    const scheduledDate = new Date(scheduledFor);
    if (Number.isNaN(scheduledDate.getTime())) {
      res.status(400).json({ error: "scheduledFor must be a valid date" });
      return;
    }
    // Allow "now" and small clock-skew/latency slack rather than a strict
    // future-only check — scheduling for immediate posting is legitimate,
    // and a rigid ">Date.now()" comparison is fragile across a real network
    // hop. Still rejects genuinely stale input (e.g. a client bug sending
    // last year's date).
    const SCHEDULED_FOR_PAST_GRACE_MS = 60_000;
    if (scheduledDate.getTime() < Date.now() - SCHEDULED_FOR_PAST_GRACE_MS) {
      res.status(400).json({ error: "scheduledFor can't be in the past" });
      return;
    }

    // Confirm the social account actually belongs to this caller before
    // scheduling against it — RLS would also catch this at the DB layer,
    // but checking explicitly here gives a clean 403 instead of an opaque
    // insert failure.
    const { data: account, error: accountError } = await supabase
      .from("social_accounts")
      .select("id, account_id, platform")
      .eq("id", socialAccountId)
      .single();
    if (accountError || !account || account.account_id !== req.accountId) {
      res.status(403).json({ error: "Social account not found or not owned by this caller" });
      return;
    }

    // Pre-flight check against the TARGET platform's real requirements —
    // this is what lets a customer find out their file doesn't comply
    // (wrong size, wrong format, wrong aspect ratio) immediately, instead
    // of only discovering it after a scheduled post silently fails later.
    // Uses server-measured metadata from media_uploads, not anything the
    // client claims. See mediaLimits.ts for exactly what is and isn't
    // checked (video duration/resolution aren't yet — needs ffprobe).
    if (mediaUrl) {
      const { data: media } = await supabase
        .from("media_uploads")
        .select("mime_type, size_bytes, width, height")
        .eq("url", mediaUrl)
        .maybeSingle();
      if (media) {
        const result = validateMediaForPlatform(account.platform as Platform, {
          mimeType: media.mime_type,
          sizeBytes: media.size_bytes,
          width: media.width,
          height: media.height,
        });
        if (!result.valid) {
          res.status(400).json({ error: result.reason });
          return;
        }
      }
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
        dbError(res, countError, "POST /scheduled-posts free-tier count");
        return;
      }
      if ((count ?? 0) >= FREE_TIER_MONTHLY_POSTS_PER_ACCOUNT) {
        res.status(403).json({
          error: `Free tier limit reached: ${FREE_TIER_MONTHLY_POSTS_PER_ACCOUNT} posts per connected account per month. Upgrade to Starter for unlimited posts, or wait until next month.`,
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
      dbError(res, error, "POST /scheduled-posts insert");
      return;
    }
    res.status(201).json(data);
  });

  router.get("/scheduled-posts", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("scheduled_posts")
      .select("*, post_results(*)")
      .eq("account_id", req.accountId)
      .order("scheduled_for", { ascending: true });
    if (error) {
      dbError(res, error, "GET /scheduled-posts");
      return;
    }
    res.json(data);
  });

  // A pending post can be deleted (cancelled before it goes out); one
  // already posting/posted/failed cannot — matches the pending-only DELETE
  // policy already enforced by RLS in 0001, checked here too for a clean
  // error message rather than a silent no-op delete.
  router.delete("/scheduled-posts/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { error, count } = await supabase
      .from("scheduled_posts")
      .delete({ count: "exact" })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .eq("status", "pending");
    if (error) {
      dbError(res, error, "DELETE /scheduled-posts/:id");
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
  router.get("/subscription", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: sub, error } = await supabase
      .from("subscriptions")
      .select("tier, status, current_period_end")
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (error) {
      dbError(res, error, "GET /subscription");
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
  router.post("/subscription/checkout", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { tier } = req.body ?? {};
    if (tier !== "pro" && tier !== "business" && tier !== "enterprise") {
      res.status(400).json({
        error: 'tier must be "pro" (Starter), "business" (Pro), or "enterprise" (Business) — use the Free tier by just not upgrading',
      });
      return;
    }

    const apiKey = process.env.MOR_API_KEY;
    // Internal tier codes were kept stable across the Starter/Pro/Business
    // rename (see tier.ts) — the env var names below reflect the CURRENT
    // display name, not the internal code, so double-check this mapping
    // against tier.ts's TIER_DISPLAY_NAMES before changing either.
    const priceId =
      tier === "pro"
        ? process.env.PADDLE_PRICE_ID_STARTER
        : tier === "business"
          ? process.env.PADDLE_PRICE_ID_PRO
          : process.env.PADDLE_PRICE_ID_BUSINESS;
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
        kind: "tier",
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
  router.post("/subscription/cancel", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const result = await cancelSubscription(req.accountId!, morAdapter);
    if (!result.success) {
      res.status(502).json({ error: result.errorMessage ?? "Cancellation failed at the payment provider" });
      return;
    }
    res.json({ cancelled: true });
  });

  // Lists the caller's active/trialing storage add-ons — the "manage your
  // extra storage" view alongside the storage gauge.
  router.get("/storage-addons", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("storage_addons")
      .select("id, gb_amount, status, current_period_end")
      .eq("account_id", req.accountId)
      .in("status", ["active", "trialing"])
      .order("created_at", { ascending: true });
    if (error) {
      dbError(res, error, "GET /storage-addons");
      return;
    }
    res.json(data);
  });

  // Starts a real Paddle checkout transaction for a storage add-on. Free
  // tier can't buy add-ons — upgrading to a real tier already includes more
  // storage; add-ons are for someone already paying who wants MORE than
  // their tier's base amount. Same checkout-overlay pattern as
  // /subscription/checkout, just a different customData shape (see
  // buildCheckoutTransaction in billing/paddle.ts).
  router.post("/storage-addons/checkout", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { gbAmount } = req.body ?? {};
    if (!STORAGE_ADDON_GB_OPTIONS.includes(gbAmount)) {
      res.status(400).json({ error: `gbAmount must be one of ${STORAGE_ADDON_GB_OPTIONS.join(", ")}` });
      return;
    }

    const tier = await resolveTier(req.accountId!);
    if (tier === "free") {
      res.status(403).json({ error: "Storage add-ons aren't available on the Free tier — upgrade to a paid plan first." });
      return;
    }

    const { count: activeAddonCount, error: countError } = await supabase
      .from("storage_addons")
      .select("id", { count: "exact", head: true })
      .eq("account_id", req.accountId)
      .in("status", ["active", "trialing"]);
    if (countError) {
      dbError(res, countError, "POST /storage-addons/checkout active-count");
      return;
    }
    if ((activeAddonCount ?? 0) >= MAX_ACTIVE_STORAGE_ADDONS) {
      res.status(403).json({
        error: `You already have ${MAX_ACTIVE_STORAGE_ADDONS} storage add-ons — cancel one before adding another.`,
      });
      return;
    }

    const apiKey = process.env.MOR_API_KEY;
    const priceId = ADDON_PRICE_ID_ENV_VAR[gbAmount as StorageAddonGb] ? process.env[ADDON_PRICE_ID_ENV_VAR[gbAmount as StorageAddonGb]] : undefined;
    if (!apiKey || !priceId) {
      res.status(503).json({ error: "Billing isn't live yet — no Paddle account/price configured for this add-on." });
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
        kind: "storage_addon",
        accountEmail: account.email,
        gbAmount,
        priceId,
      });
      res.json({ transactionId, checkoutUrl });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Cancels a single storage add-on — does not touch the account's main
  // tier subscription. See billing/sync.ts's cancelStorageAddon.
  router.post("/storage-addons/:id/cancel", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const result = await cancelStorageAddon(req.accountId!, String(req.params.id), morAdapter);
    if (!result.success) {
      res.status(502).json({ error: result.errorMessage ?? "Cancellation failed at the payment provider" });
      return;
    }
    res.json({ cancelled: true });
  });

  return router;
}
