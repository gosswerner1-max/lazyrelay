import { Router, type Response } from "express";
import multer from "multer";
import { randomUUID, randomBytes } from "node:crypto";
import { imageSize } from "image-size";
import { fileTypeFromBuffer } from "file-type";
import { supabase } from "../supabase.js";
import { cancelSubscription, cancelStorageAddon } from "../billing/sync.js";
import { buildCheckoutTransaction } from "../billing/paddle.js";
import { Environment } from "@paddle/paddle-node-sdk";
import type { MerchantOfRecordAdapter } from "../billing/types.js";
import { startConnect, completeConnect, type PlatformAdapterRegistry } from "../platforms/connect.js";
import { requireAuth, requireHumanAuth, type AuthedRequest, API_KEY_PREFIX, hashApiKey } from "./auth.js";
import { tieredRateLimit, publicRateLimit } from "./rateLimit.js";
import { validateMediaForPlatform, type Platform } from "../mediaLimits.js";
import { checkQuotaForNewUpload, getStorageUsage } from "../storageQuota.js";
import { checkAccountLimit } from "../accountLimits.js";
import { resolveTier, RECURRING_SCHEDULE_SLOT_LIMITS, type Tier } from "../tier.js";
import { cancelFuturePendingOccurrences } from "../recurringScheduler.js";

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

// Deleting a scheduled_posts row never touches the underlying media_uploads
// row/storage file on its own — the same uploaded file can be attached to
// several scheduled posts (e.g. one fan-out schedule to 3 platforms). Only
// reclaim it once nothing else pending/posting still references the URL,
// mirroring DELETE /media/:id's in-use check but firing silently as a
// side-effect of post deletion rather than a user-facing 409.
async function releaseMediaIfOrphaned(mediaUrl: string, accountId: string): Promise<void> {
  const { count: stillInUse } = await supabase
    .from("scheduled_posts")
    .select("id", { count: "exact", head: true })
    .eq("media_url", mediaUrl)
    .in("status", ["pending", "posting"]);
  if ((stillInUse ?? 0) > 0) return;

  const { data: media } = await supabase
    .from("media_uploads")
    .select("id, storage_path")
    .eq("url", mediaUrl)
    .eq("account_id", accountId)
    .maybeSingle();
  if (!media) return;

  if (media.storage_path) {
    await supabase.storage.from("post-media").remove([media.storage_path]);
  }
  await supabase.from("media_uploads").delete().eq("id", media.id);
}

// Every platform LazyRelay supports, in the shape the frontend's platform
// picker grid needs. "x" and "reddit" are always comingSoon: true — X has
// no adapter built yet, Reddit is blocked on Reddit's own commercial-API
// approval (see product/reference-social-automation-saas-venture-research
// memory) — neither is ever in the registry, so they'd otherwise just show
// up as "not configured" with no explanation.
const ALL_PLATFORMS = [
  "tiktok", "pinterest", "youtube", "mastodon", "bluesky", "telegram",
  "linkedin", "threads", "facebook", "instagram", "discord", "tumblr",
  "x", "reddit",
] as const;
const COMING_SOON_PLATFORMS = new Set(["x", "reddit"]);

export function buildRouter(morAdapter: MerchantOfRecordAdapter, registry: PlatformAdapterRegistry): Router {
  const router = Router();

  // Drives the frontend's platform-picker grid — every platform LazyRelay
  // supports, whether it's actually configured (in the registry) right
  // now, and whether it's a "coming soon" tile that should never be
  // clickable regardless of configuration.
  router.get("/platforms", requireAuth, tieredRateLimit, (_req: AuthedRequest, res) => {
    res.json(
      ALL_PLATFORMS.map((platform) => ({
        platform,
        configured: registry.has(platform),
        comingSoon: COMING_SOON_PLATFORMS.has(platform),
      })),
    );
  });

  // Starts the "connect your social account" flow — returns the URL the
  // frontend should redirect the user to. Real account identity comes from
  // the verified JWT; the callback below never has to trust anything the
  // browser sends except the opaque, one-time state token.
  router.get("/social-accounts/connect", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { platform } = req.query;
    if (typeof platform !== "string" || !ALL_PLATFORMS.includes(platform as (typeof ALL_PLATFORMS)[number])) {
      res.status(400).json({ error: `platform must be one of: ${ALL_PLATFORMS.join(", ")}` });
      return;
    }
    if (COMING_SOON_PLATFORMS.has(platform)) {
      res.status(400).json({ error: `${platform} is coming soon and isn't available to connect yet.` });
      return;
    }
    try {
      // Real per-tier cap, not just marketing copy — see accountLimits.ts
      // for why even the top tier is capped rather than truly unlimited.
      const limitError = await checkAccountLimit(req.accountId!);
      if (limitError) {
        res.status(403).json({ error: limitError });
        return;
      }
      const url = await startConnect(req.accountId!, platform, registry);
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
  //
  // This is the platform's own redirect_uri, so the browser lands here —
  // on the API's domain, not the frontend's — no matter what. The one
  // thing that WAS broken (not something this refactor introduced): once
  // the exchange finished, this used to just dead-end on a raw JSON blob
  // instead of ever sending the customer back to their dashboard. It now
  // redirects to the frontend either way, success or failure, with a query
  // param the dashboard reads once and clears (see Dashboard.tsx).
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
  router.get("/social-accounts/callback", publicRateLimit, async (req, res) => {
    const { code, state } = req.query;
    if (typeof code !== "string" || typeof state !== "string") {
      res.redirect(`${frontendUrl}/?connectError=${encodeURIComponent("Missing code or state")}`);
      return;
    }
    try {
      await completeConnect(state, code, registry);
      res.redirect(`${frontendUrl}/?connected=1`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.redirect(`${frontendUrl}/?connectError=${encodeURIComponent(message)}`);
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
    // The client-supplied mimetype/filename (file.mimetype, file.originalname)
    // are just headers the caller chose to send — trusting them is how a file
    // named "photo.png.exe" with a spoofed image/png Content-Type would sail
    // through and land in storage with a literal .exe extension. Detect the
    // REAL type from the file's magic bytes instead, and use that (not
    // anything client-supplied) for both the allowlist check and the stored
    // file's extension/content-type.
    const detected = await fileTypeFromBuffer(file.buffer);
    if (!detected || !ALLOWED_MEDIA_MIME_TYPES.has(detected.mime)) {
      res.status(400).json({
        error: `Unsupported or unrecognized file type${detected ? ` "${detected.mime}"` : ""} — use an image (jpeg/png/webp/gif) or video (mp4/mov/webm)`,
      });
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

    const path = `${req.accountId}/${randomUUID()}.${detected.ext}`;
    const { error: uploadError } = await supabase.storage
      .from("post-media")
      .upload(path, file.buffer, { contentType: detected.mime });
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
    if (detected.mime.startsWith("image/")) {
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
      mime_type: detected.mime,
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
  //
  // Extracted from the route body so /scheduled-posts/bulk (CSV import) can
  // run the exact same validation/limits per row instead of a parallel,
  // easily-drifting copy. Returns an HTTP-shaped result rather than
  // throwing, since a bulk caller needs to keep going past one bad row.
  async function scheduleOnePost(
    accountId: string | undefined,
    input: { socialAccountId?: unknown; content?: unknown; mediaUrl?: unknown; scheduledFor?: unknown },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const { socialAccountId, content, mediaUrl, scheduledFor } = input;
    if (!socialAccountId || !content || !scheduledFor) {
      return { status: 400, body: { error: "socialAccountId, content, and scheduledFor are required" } };
    }
    if (typeof socialAccountId !== "string") {
      return { status: 400, body: { error: "socialAccountId must be a string" } };
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      return { status: 400, body: { error: "content must be a non-empty string" } };
    }
    if (content.length > MAX_POST_CONTENT_LENGTH) {
      return { status: 400, body: { error: `content must be ${MAX_POST_CONTENT_LENGTH} characters or fewer` } };
    }
    if (typeof scheduledFor !== "string") {
      return { status: 400, body: { error: "scheduledFor must be an ISO date string" } };
    }
    const scheduledDate = new Date(scheduledFor);
    if (Number.isNaN(scheduledDate.getTime())) {
      return { status: 400, body: { error: "scheduledFor must be a valid date" } };
    }
    // Allow "now" and small clock-skew/latency slack rather than a strict
    // future-only check — scheduling for immediate posting is legitimate,
    // and a rigid ">Date.now()" comparison is fragile across a real network
    // hop. Still rejects genuinely stale input (e.g. a client bug sending
    // last year's date).
    const SCHEDULED_FOR_PAST_GRACE_MS = 60_000;
    if (scheduledDate.getTime() < Date.now() - SCHEDULED_FOR_PAST_GRACE_MS) {
      return { status: 400, body: { error: "scheduledFor can't be in the past" } };
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
    if (accountError || !account || account.account_id !== accountId) {
      return { status: 403, body: { error: "Social account not found or not owned by this caller" } };
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
        // account.platform is DB-sourced (the CHECK constraint already
        // limits it to the real platform union), not client input — the
        // cast here is safe now that mediaLimits.ts's Platform type covers
        // all 13 real values, not just 3.
        const result = validateMediaForPlatform(account.platform as Platform, {
          mimeType: media.mime_type,
          sizeBytes: media.size_bytes,
          width: media.width,
          height: media.height,
        });
        if (!result.valid) {
          return { status: 400, body: { error: result.reason } };
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
      .eq("account_id", accountId)
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
        console.error("[routes] scheduleOnePost free-tier count:", countError.message);
        return { status: 500, body: { error: "Something went wrong on our end. Please try again." } };
      }
      if ((count ?? 0) >= FREE_TIER_MONTHLY_POSTS_PER_ACCOUNT) {
        return {
          status: 403,
          body: {
            error: `Free tier limit reached: ${FREE_TIER_MONTHLY_POSTS_PER_ACCOUNT} posts per connected account per month. Upgrade to Starter for unlimited posts, or wait until next month.`,
          },
        };
      }
    }

    const { data, error } = await supabase
      .from("scheduled_posts")
      .insert({
        account_id: accountId,
        social_account_id: socialAccountId,
        content,
        media_url: mediaUrl ?? null,
        scheduled_for: scheduledFor,
      })
      .select()
      .single();
    if (error) {
      console.error("[routes] scheduleOnePost insert:", error.message);
      return { status: 500, body: { error: "Something went wrong on our end. Please try again." } };
    }
    return { status: 201, body: data };
  }

  router.post("/scheduled-posts", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const result = await scheduleOnePost(req.accountId, req.body ?? {});
    res.status(result.status).json(result.body);
  });

  // Bulk/CSV import — same validation and tier limits as a single post,
  // run per row so one bad row doesn't sink the rest of the batch. The
  // caller (frontend) parses the CSV client-side and posts structured rows
  // here; running rows sequentially (not Promise.all) matters for
  // correctness, not just simplicity — two rows for the same free-tier
  // account racing the same monthly-count check in parallel could both
  // read "9 used" and both insert, silently exceeding the limit.
  const MAX_BULK_POSTS = 200;
  router.post("/scheduled-posts/bulk", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { posts } = req.body ?? {};
    if (!Array.isArray(posts) || posts.length === 0) {
      res.status(400).json({ error: "posts must be a non-empty array" });
      return;
    }
    if (posts.length > MAX_BULK_POSTS) {
      res.status(400).json({ error: `A single bulk import is capped at ${MAX_BULK_POSTS} posts — split into smaller batches.` });
      return;
    }

    const results: Array<{ row: number; status: number; body: Record<string, unknown> }> = [];
    for (let i = 0; i < posts.length; i++) {
      const result = await scheduleOnePost(req.accountId, posts[i] ?? {});
      results.push({ row: i, status: result.status, body: result.body });
    }

    const succeeded = results.filter((r) => r.status === 201).length;
    res.status(200).json({ succeeded, failed: results.length - succeeded, results });
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

  // Phase 1 analytics — post-level engagement (likes/shares/views) isn't
  // available yet: that needs a per-platform metrics-fetch method this
  // codebase doesn't have (a real, larger scope, not an oversight). This
  // aggregates what LazyRelay already collects — Proof-of-Publish results —
  // into the operational numbers a customer actually needs today: how many
  // posts went out, per platform, how many actually verified live vs
  // failed, and the daily volume trend.
  router.get("/analytics/summary", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("scheduled_posts")
      .select("id, status, scheduled_for, social_accounts(platform), post_results(verified_live, error_message)")
      .eq("account_id", req.accountId)
      .gte("scheduled_for", since)
      .order("scheduled_for", { ascending: true });
    if (error) {
      dbError(res, error, "GET /analytics/summary");
      return;
    }

    const byStatus: Record<string, number> = {};
    const byPlatform: Record<string, { total: number; posted: number; failed: number; verifiedLive: number }> = {};
    const dailyCounts: Record<string, number> = {};
    let verifiedLiveCount = 0;
    let postedCount = 0;

    for (const row of data ?? []) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;

      // social_accounts(platform) comes back as an array with the !inner
      // shorthand unused here, so it's a single related row in practice —
      // guard defensively rather than assuming Supabase's join shape.
      const platform = Array.isArray(row.social_accounts) ? row.social_accounts[0]?.platform : (row.social_accounts as { platform?: string } | null)?.platform;
      const platformKey = platform ?? "unknown";
      byPlatform[platformKey] ??= { total: 0, posted: 0, failed: 0, verifiedLive: 0 };
      byPlatform[platformKey].total += 1;
      if (row.status === "posted") byPlatform[platformKey].posted += 1;
      if (row.status === "failed") byPlatform[platformKey].failed += 1;

      const results = Array.isArray(row.post_results) ? row.post_results : row.post_results ? [row.post_results] : [];
      const verifiedLive = results.some((r: { verified_live: boolean }) => r.verified_live);
      if (verifiedLive) {
        byPlatform[platformKey].verifiedLive += 1;
        verifiedLiveCount += 1;
      }
      if (row.status === "posted") postedCount += 1;

      const day = row.scheduled_for.slice(0, 10);
      dailyCounts[day] = (dailyCounts[day] ?? 0) + 1;
    }

    res.json({
      rangeDays: days,
      totalPosts: data?.length ?? 0,
      byStatus,
      byPlatform,
      dailyCounts,
      verifiedLiveRate: postedCount > 0 ? verifiedLiveCount / postedCount : null,
    });
  });

  // A pending post can be cancelled, or a posted/failed one cleared from
  // history — either way this is deleting the customer's own row. Only a
  // post mid-flight ("posting") is protected, since the scheduler is
  // actively working it at that moment.
  router.delete("/scheduled-posts/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: existing, error: fetchError } = await supabase
      .from("scheduled_posts")
      .select("id, media_url, status")
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (fetchError) {
      dbError(res, fetchError, "DELETE /scheduled-posts/:id lookup");
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    if (existing.status === "posting") {
      res.status(409).json({ error: "This post is being published right now — try again in a moment" });
      return;
    }

    const { error, count } = await supabase
      .from("scheduled_posts")
      .delete({ count: "exact" })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId);
    if (error) {
      dbError(res, error, "DELETE /scheduled-posts/:id");
      return;
    }
    if (count === 0) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }

    // Deleting the post is what a customer actually means by "free up
    // storage" — reclaim the attached media too, but only once nothing else
    // (another pending/posting post) still points at the same file.
    if (existing.media_url) {
      await releaseMediaIfOrphaned(existing.media_url, req.accountId!);
    }
    res.status(204).send();
  });

  // --- Recurring schedules ("set it up once a week") ---
  // See docs/feature-spec-recurring-schedules.md for the full design.

  const DAYS_OF_WEEK_RANGE = { min: 1, max: 7 }; // ISO weekday, 1=Mon..7=Sun

  function isValidTimezone(tz: string): boolean {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }

  interface RecurringScheduleInput {
    content?: unknown;
    mediaUrl?: unknown;
    socialAccountIds?: unknown;
    daysOfWeek?: unknown;
    timeOfDay?: unknown;
    timezone?: unknown;
    startsOn?: unknown;
    endsOn?: unknown;
  }

  /** Shared validation for both create and edit — returns a customer-facing
   *  error string, or null if everything present is valid. Fields not
   *  present in `input` (relevant for PATCH, which may only be setting
   *  `status`) are skipped rather than required. */
  function validateRecurringScheduleInput(input: RecurringScheduleInput, requireAll: boolean): string | null {
    if (requireAll || input.content !== undefined) {
      if (typeof input.content !== "string" || input.content.trim().length === 0) {
        return "content must be a non-empty string";
      }
      if (input.content.length > MAX_POST_CONTENT_LENGTH) {
        return `content must be ${MAX_POST_CONTENT_LENGTH} characters or fewer`;
      }
    }
    if (requireAll || input.socialAccountIds !== undefined) {
      if (!Array.isArray(input.socialAccountIds) || input.socialAccountIds.length === 0) {
        return "socialAccountIds must be a non-empty array";
      }
      if (!input.socialAccountIds.every((id) => typeof id === "string")) {
        return "socialAccountIds must all be strings";
      }
    }
    if (requireAll || input.daysOfWeek !== undefined) {
      if (
        !Array.isArray(input.daysOfWeek) ||
        input.daysOfWeek.length === 0 ||
        input.daysOfWeek.length > 7 ||
        !input.daysOfWeek.every(
          (d) => typeof d === "number" && Number.isInteger(d) && d >= DAYS_OF_WEEK_RANGE.min && d <= DAYS_OF_WEEK_RANGE.max,
        )
      ) {
        return "daysOfWeek must be 1-7 integers (1=Monday..7=Sunday)";
      }
    }
    if (requireAll || input.timeOfDay !== undefined) {
      if (typeof input.timeOfDay !== "string" || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(input.timeOfDay)) {
        return "timeOfDay must be in HH:mm format (24-hour)";
      }
    }
    if (requireAll || input.timezone !== undefined) {
      if (typeof input.timezone !== "string" || !isValidTimezone(input.timezone)) {
        return "timezone must be a valid IANA timezone name (e.g. \"Africa/Johannesburg\")";
      }
    }
    if (input.startsOn !== undefined && input.startsOn !== null) {
      if (typeof input.startsOn !== "string" || Number.isNaN(new Date(input.startsOn).getTime())) {
        return "startsOn must be a valid date string";
      }
    }
    if (input.endsOn !== undefined && input.endsOn !== null) {
      if (typeof input.endsOn !== "string" || Number.isNaN(new Date(input.endsOn).getTime())) {
        return "endsOn must be a valid date string";
      }
    }
    return null;
  }

  router.post("/recurring-schedules", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const input = (req.body ?? {}) as RecurringScheduleInput;
    const validationError = validateRecurringScheduleInput(input, true);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const tier = await resolveTier(req.accountId!);
    const limit = RECURRING_SCHEDULE_SLOT_LIMITS[tier];
    if (limit === 0) {
      res.status(403).json({
        error: "Recurring schedules are a paid-tier feature. Upgrade to Starter, Pro, or Business to set up recurring posts.",
      });
      return;
    }
    if (limit !== null) {
      // Any status counts against the cap — a paused slot still occupies a
      // content cadence, it hasn't been deleted.
      const { count, error: countError } = await supabase
        .from("recurring_schedules")
        .select("id", { count: "exact", head: true })
        .eq("account_id", req.accountId);
      if (countError) {
        dbError(res, countError, "POST /recurring-schedules slot count");
        return;
      }
      if ((count ?? 0) >= limit) {
        res.status(403).json({
          error: `Your plan allows up to ${limit} recurring schedules. Delete one, or upgrade for more.`,
        });
        return;
      }
    }

    // Confirm every target social account actually belongs to this caller —
    // same ownership check POST /scheduled-posts already does for a single
    // account, applied per-target here.
    const socialAccountIds = input.socialAccountIds as string[];
    const { data: owned, error: ownedError } = await supabase
      .from("social_accounts")
      .select("id")
      .eq("account_id", req.accountId)
      .in("id", socialAccountIds);
    if (ownedError) {
      dbError(res, ownedError, "POST /recurring-schedules ownership check");
      return;
    }
    if ((owned ?? []).length !== socialAccountIds.length) {
      res.status(403).json({ error: "One or more social accounts weren't found or aren't owned by this caller" });
      return;
    }

    const { data: slot, error } = await supabase
      .from("recurring_schedules")
      .insert({
        account_id: req.accountId,
        content: input.content,
        media_url: input.mediaUrl ?? null,
        days_of_week: input.daysOfWeek,
        time_of_day: `${input.timeOfDay}:00`,
        timezone: input.timezone,
        starts_on: input.startsOn ?? undefined,
        ends_on: input.endsOn ?? null,
      })
      .select()
      .single();
    if (error || !slot) {
      dbError(res, error ?? { message: "insert returned no row" }, "POST /recurring-schedules insert");
      return;
    }

    const { error: targetsError } = await supabase
      .from("recurring_schedule_targets")
      .insert(socialAccountIds.map((social_account_id) => ({ recurring_schedule_id: slot.id, social_account_id })));
    if (targetsError) {
      // Roll back the slot rather than leaving an orphaned schedule with no
      // targets — a slot with zero targets would never generate anything
      // and would silently occupy the customer's tier cap for nothing.
      await supabase.from("recurring_schedules").delete().eq("id", slot.id);
      dbError(res, targetsError, "POST /recurring-schedules targets insert");
      return;
    }

    res.status(201).json({ ...slot, social_account_ids: socialAccountIds });
  });

  router.get("/recurring-schedules", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("recurring_schedules")
      .select("*, recurring_schedule_targets(social_account_id)")
      .eq("account_id", req.accountId)
      .order("created_at", { ascending: false });
    if (error) {
      dbError(res, error, "GET /recurring-schedules");
      return;
    }
    res.json(
      (data ?? []).map((slot) => ({
        ...slot,
        social_account_ids: slot.recurring_schedule_targets.map((t: { social_account_id: string }) => t.social_account_id),
        recurring_schedule_targets: undefined,
      })),
    );
  });

  router.patch("/recurring-schedules/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: existing, error: fetchError } = await supabase
      .from("recurring_schedules")
      .select("id, status")
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (fetchError) {
      dbError(res, fetchError, "PATCH /recurring-schedules/:id lookup");
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }

    const input = (req.body ?? {}) as RecurringScheduleInput & { status?: unknown };
    if (input.status !== undefined && input.status !== "active" && input.status !== "paused") {
      res.status(400).json({ error: "status must be \"active\" or \"paused\"" });
      return;
    }
    const validationError = validateRecurringScheduleInput(input, false);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    // Resuming (paused -> active, nothing else changing) never needs to
    // cancel anything — there's nothing stale to invalidate. Every other
    // change — pausing, or editing any content/schedule field while
    // active — cancels future not-yet-fired generated occurrences per the
    // "no in-place update" decision: the customer's save regenerates fresh
    // ones under the new configuration on the next generation cycle.
    const isPureResume = input.status === "active" && existing.status === "paused" &&
      input.content === undefined && input.mediaUrl === undefined && input.socialAccountIds === undefined &&
      input.daysOfWeek === undefined && input.timeOfDay === undefined && input.timezone === undefined &&
      input.startsOn === undefined && input.endsOn === undefined;
    if (!isPureResume) {
      await cancelFuturePendingOccurrences(req.params.id as string);
    }

    if (input.socialAccountIds !== undefined) {
      const socialAccountIds = input.socialAccountIds as string[];
      const { data: owned, error: ownedError } = await supabase
        .from("social_accounts")
        .select("id")
        .eq("account_id", req.accountId)
        .in("id", socialAccountIds);
      if (ownedError) {
        dbError(res, ownedError, "PATCH /recurring-schedules/:id ownership check");
        return;
      }
      if ((owned ?? []).length !== socialAccountIds.length) {
        res.status(403).json({ error: "One or more social accounts weren't found or aren't owned by this caller" });
        return;
      }
      await supabase.from("recurring_schedule_targets").delete().eq("recurring_schedule_id", req.params.id);
      const { error: targetsError } = await supabase
        .from("recurring_schedule_targets")
        .insert(socialAccountIds.map((social_account_id) => ({ recurring_schedule_id: req.params.id, social_account_id })));
      if (targetsError) {
        dbError(res, targetsError, "PATCH /recurring-schedules/:id targets update");
        return;
      }
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.content !== undefined) updates.content = input.content;
    if (input.mediaUrl !== undefined) updates.media_url = input.mediaUrl;
    if (input.daysOfWeek !== undefined) updates.days_of_week = input.daysOfWeek;
    if (input.timeOfDay !== undefined) updates.time_of_day = `${input.timeOfDay}:00`;
    if (input.timezone !== undefined) updates.timezone = input.timezone;
    if (input.startsOn !== undefined) updates.starts_on = input.startsOn;
    if (input.endsOn !== undefined) updates.ends_on = input.endsOn;
    if (input.status !== undefined) updates.status = input.status;

    const { data: updated, error } = await supabase
      .from("recurring_schedules")
      .update(updates)
      .eq("id", req.params.id)
      .select()
      .single();
    if (error || !updated) {
      dbError(res, error ?? { message: "update returned no row" }, "PATCH /recurring-schedules/:id");
      return;
    }
    res.json(updated);
  });

  // ?cancelUpcoming=true also cancels not-yet-fired generated occurrences;
  // without it, already-generated pending posts are detached (their
  // recurring_schedule_id set null via the FK's `on delete set null`) and
  // left to fire normally — history is never touched either way.
  router.delete("/recurring-schedules/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: existing, error: fetchError } = await supabase
      .from("recurring_schedules")
      .select("id")
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (fetchError) {
      dbError(res, fetchError, "DELETE /recurring-schedules/:id lookup");
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }

    if (req.query.cancelUpcoming === "true") {
      await cancelFuturePendingOccurrences(req.params.id as string);
    }

    const { error } = await supabase.from("recurring_schedules").delete().eq("id", req.params.id);
    if (error) {
      dbError(res, error, "DELETE /recurring-schedules/:id");
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
    const { feedback } = req.body ?? {};
    const result = await cancelSubscription(req.accountId!, morAdapter, typeof feedback === "string" ? feedback : undefined);
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

  // The dashboard's "Welcome, {name}" header and the business-name field
  // shown at signup — set once at signup via Supabase auth metadata (see
  // migration 0024), editable afterward here.
  router.get("/account", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase.from("accounts").select("email, business_name").eq("id", req.accountId).single();
    if (error || !data) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    res.json({ email: data.email, businessName: data.business_name });
  });

  router.patch("/account", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { businessName } = req.body ?? {};
    if (businessName !== null && typeof businessName !== "string") {
      res.status(400).json({ error: "businessName must be a string or null" });
      return;
    }
    if (typeof businessName === "string" && businessName.length > 80) {
      res.status(400).json({ error: "businessName must be 80 characters or fewer" });
      return;
    }
    const { data, error } = await supabase
      .from("accounts")
      .update({ business_name: businessName?.trim() || null })
      .eq("id", req.accountId)
      .select("email, business_name")
      .single();
    if (error || !data) {
      dbError(res, error ?? { message: "update returned no row" }, "PATCH /account");
      return;
    }
    res.json({ email: data.email, businessName: data.business_name });
  });

  // API keys let a customer's own AI agent call this API directly and
  // headlessly (bring-your-own-agent — see tier.ts/pricing copy) instead of
  // needing a Supabase browser session, which by definition requires a
  // human to log in. Only requireAuth's Supabase-JWT path may create or
  // list keys — an agent authenticating WITH an API key can't mint more of
  // them, so a leaked key can't be used to self-escalate into permanent
  // access if the original key is later revoked.
  router.post("/api-keys", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (name.length > 60) {
      res.status(400).json({ error: "name must be 60 characters or fewer" });
      return;
    }
    const rawKey = `${API_KEY_PREFIX}${randomBytes(24).toString("hex")}`;
    const { data, error } = await supabase
      .from("api_keys")
      .insert({
        account_id: req.accountId,
        name: name.trim(),
        key_prefix: rawKey.slice(0, API_KEY_PREFIX.length + 6),
        key_hash: hashApiKey(rawKey),
      })
      .select("id, name, key_prefix, created_at")
      .single();
    if (error || !data) {
      dbError(res, error ?? { message: "insert returned no row" }, "POST /api-keys");
      return;
    }
    // The only time the raw key is ever returned — it's not retrievable
    // again after this response, only key_prefix is kept for display.
    res.status(201).json({ ...data, key: rawKey });
  });

  router.get("/api-keys", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("api_keys")
      .select("id, name, key_prefix, created_at, last_used_at, revoked_at")
      .eq("account_id", req.accountId)
      .order("created_at", { ascending: false });
    if (error) {
      dbError(res, error, "GET /api-keys");
      return;
    }
    res.json(data);
  });

  router.delete("/api-keys/:id", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: key } = await supabase.from("api_keys").select("account_id").eq("id", req.params.id).maybeSingle();
    if (!key || key.account_id !== req.accountId) {
      res.status(404).json({ error: "API key not found" });
      return;
    }
    const { error } = await supabase
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", req.params.id);
    if (error) {
      dbError(res, error, "DELETE /api-keys/:id");
      return;
    }
    res.status(204).end();
  });

  return router;
}
