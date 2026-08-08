import { Router, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
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
import { requireAuth, requireHumanAuth, requireAdmin, type AuthedRequest, API_KEY_PREFIX, hashApiKey } from "./auth.js";
import { tieredRateLimit, publicRateLimit } from "./rateLimit.js";
import { validateMediaForPlatform, type Platform } from "../mediaLimits.js";
import { checkQuotaForNewUpload, getStorageUsage } from "../storageQuota.js";
import { checkAccountLimit } from "../accountLimits.js";
import { resolveTier, RECURRING_SCHEDULE_SLOT_LIMITS, type Tier } from "../tier.js";
import { cancelFuturePendingOccurrences } from "../recurringScheduler.js";
import { checkGenerationLimit, recordGeneration } from "../aiUsage.js";
import { triageItems, type TriageItem, type TriageResult } from "../commentTriage.js";
import type { CommentItem } from "../platforms/types.js";
import { generateWebhookSecret } from "../webhook.js";

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

// Used to build the public Proof-of-Publish share link returned by
// GET /scheduled-posts/:id/proof-link (see migration
// 0038_proof_link_sharing.sql). No env var for this today — same fixed
// production domain every other public link in this codebase assumes.
const PUBLIC_SITE_URL = "https://lazyrelay.com";

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
// picker grid needs. "x" had a comingSoon gate until 2026-07-31 — its
// adapter is now built, credentials are live on Render, and it's confirmed
// in the registry, so it's a real, connectable platform now, not just "not
// configured." Reddit was dropped from the roadmap entirely on 2026-07-30
// in favor of Snapchat (see
// product/reference-social-automation-saas-venture-research and
// lazyrelay/project-snapchat-replaces-reddit-2026-07-30 memory) — removed
// from this list rather than left as a stale "coming soon" tile pointing at
// a platform that's no longer the plan. "snapchat" is comingSoon: true —
// its adapter is code-complete (platforms/snapchat.ts) but has never been
// tested against a real API response, no OAuth app exists yet (Business
// Manager setup paused mid-way), and the Public Profile API is
// allowlist-only regardless — real credentials won't be enough on their
// own, Snap has to manually allowlist the client ID too. "x" is also
// comingSoon: true — the adapter is code-complete and registered, but
// X's API is pay-per-use (Basic tier $200/mo just for write access), and
// the user decided 2026-08-04 to hold off funding it until there's real
// customer demand, rather than pay for an untested, unused integration.
const ALL_PLATFORMS = [
  "tiktok", "pinterest", "youtube", "mastodon", "bluesky", "telegram",
  "linkedin", "threads", "facebook", "instagram", "discord", "tumblr", "x",
  "snapchat",
] as const;
const COMING_SOON_PLATFORMS = new Set<string>(["snapchat", "x"]);

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

  // AI caption generation — optional, only live when ANTHROPIC_API_KEY is
  // set (mirrors every other optional integration's fall-through pattern:
  // missing config degrades this one feature, not the whole API). The
  // client is created per-request rather than once at module load so a
  // missing key produces a clean 503 instead of crashing boot.
  const MAX_CAPTION_TOPIC_LENGTH = 500;
  router.post("/ai/caption", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "AI caption generation isn't set up on this deploy yet." });
      return;
    }
    const { topic, platform, tone } = req.body ?? {};
    if (typeof topic !== "string" || topic.trim().length === 0) {
      res.status(400).json({ error: "topic must be a non-empty string" });
      return;
    }
    if (topic.length > MAX_CAPTION_TOPIC_LENGTH) {
      res.status(400).json({ error: `topic must be ${MAX_CAPTION_TOPIC_LENGTH} characters or fewer` });
      return;
    }
    const platformLabel = typeof platform === "string" && platform.trim() ? platform.trim() : "a general social platform";
    const toneLabel = typeof tone === "string" && tone.trim() ? tone.trim() : "friendly and direct";

    const limitReason = await checkGenerationLimit(req.accountId!);
    if (limitReason) {
      res.status(429).json({ error: limitReason });
      return;
    }

    try {
      // Explicit timeout — an unbounded call here would hold the request
      // open indefinitely if Anthropic ever hangs, and could hit a generic
      // proxy timeout instead of this route's own clean error response.
      // 20s is generous headroom for Haiku + max_tokens 400 (normally a
      // couple seconds) while still failing well before that.
      const client = new Anthropic({ apiKey, timeout: 20_000 });
      const message = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content:
              `Write one social media post for ${platformLabel} about: ${topic}\n\n` +
              `Tone: ${toneLabel}. Output ONLY the post text — no preamble, no quotation marks, no options to choose from, no hashtag spam (at most 2-3 relevant hashtags if the platform culture calls for them). Keep it native to how real people post, not like marketing copy.`,
          },
        ],
      });
      const textBlock = message.content.find((block) => block.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        res.status(502).json({ error: "AI caption generation returned no usable text." });
        return;
      }
      await recordGeneration(req.accountId!);
      res.json({ caption: textBlock.text.trim() });
    } catch (err) {
      console.error("[routes] POST /ai/caption:", err instanceof Error ? err.message : err);
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        res.status(504).json({ error: "AI caption generation took too long — please try again." });
        return;
      }
      res.status(502).json({ error: "AI caption generation failed — please try again." });
    }
  });

  // Hashtag suggestions — same optional-integration gate as /ai/caption.
  // Takes the post content itself (not a separate topic) so suggestions are
  // grounded in what's actually being posted, not a guess from a short
  // label. Instagram's 5-hashtag cap (see reference-blotato memory) isn't
  // enforced server-side here — this returns a reasonable general count and
  // leaves platform-specific trimming to the customer, same as content
  // length isn't platform-validated until actual scheduling.
  router.post("/ai/hashtags", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "AI hashtag suggestions aren't set up on this deploy yet." });
      return;
    }
    const { content, platform } = req.body ?? {};
    if (typeof content !== "string" || content.trim().length === 0) {
      res.status(400).json({ error: "content must be a non-empty string" });
      return;
    }
    if (content.length > MAX_POST_CONTENT_LENGTH) {
      res.status(400).json({ error: `content must be ${MAX_POST_CONTENT_LENGTH} characters or fewer` });
      return;
    }
    const platformLabel = typeof platform === "string" && platform.trim() ? platform.trim() : "a general social platform";

    const limitReason = await checkGenerationLimit(req.accountId!);
    if (limitReason) {
      res.status(429).json({ error: limitReason });
      return;
    }

    try {
      // Same timeout reasoning as /ai/caption above — bounded failure
      // instead of an indefinitely open request.
      const client = new Anthropic({ apiKey, timeout: 20_000 });
      const message = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content:
              `Suggest 5-8 relevant hashtags for this ${platformLabel} post:\n\n${content}\n\n` +
              `Output ONLY the hashtags, space-separated, each starting with #, no other text, no numbering, no explanation. Mix broad-reach and niche-specific tags — not all generic, not all obscure.`,
          },
        ],
      });
      const textBlock = message.content.find((block) => block.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        res.status(502).json({ error: "AI hashtag suggestions returned no usable text." });
        return;
      }
      const hashtags = textBlock.text
        .trim()
        .split(/\s+/)
        .filter((tag) => tag.startsWith("#") && tag.length > 1);
      await recordGeneration(req.accountId!);
      res.json({ hashtags });
    } catch (err) {
      console.error("[routes] POST /ai/hashtags:", err instanceof Error ? err.message : err);
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        res.status(504).json({ error: "AI hashtag suggestions took too long — please try again." });
        return;
      }
      res.status(502).json({ error: "AI hashtag suggestions failed — please try again." });
    }
  });

  // Link-in-bio page — one per account, the kind of page a customer puts
  // in their Instagram/TikTok bio. Reads own page/links for the dashboard
  // editor; the public rendering route is further down, not behind
  // requireAuth (see 0027_bio_pages.sql for why RLS alone can't serve it).
  const BIO_SLUG_PATTERN = /^[a-z0-9-]{3,40}$/;
  router.get("/bio-page", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: page, error } = await supabase.from("bio_pages").select("*").eq("account_id", req.accountId).maybeSingle();
    if (error) {
      dbError(res, error, "GET /bio-page");
      return;
    }
    if (!page) {
      res.json(null);
      return;
    }
    const { data: links, error: linksError } = await supabase
      .from("bio_links")
      .select("*")
      .eq("bio_page_id", page.id)
      .order("position", { ascending: true });
    if (linksError) {
      dbError(res, linksError, "GET /bio-page links");
      return;
    }
    res.json({ ...page, links: links ?? [] });
  });

  router.put("/bio-page", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { slug, title, bio, avatarUrl } = req.body ?? {};
    if (typeof slug !== "string" || !BIO_SLUG_PATTERN.test(slug)) {
      res.status(400).json({ error: "slug must be 3-40 characters: lowercase letters, numbers, and hyphens only" });
      return;
    }
    if (typeof title !== "string" || title.length > 100) {
      res.status(400).json({ error: "title must be a string, 100 characters or fewer" });
      return;
    }
    if (typeof bio !== "string" || bio.length > 500) {
      res.status(400).json({ error: "bio must be a string, 500 characters or fewer" });
      return;
    }

    const { data: slugOwner } = await supabase.from("bio_pages").select("account_id").eq("slug", slug).maybeSingle();
    if (slugOwner && slugOwner.account_id !== req.accountId) {
      res.status(409).json({ error: "That link name is already taken — pick another." });
      return;
    }

    const { data, error } = await supabase
      .from("bio_pages")
      .upsert(
        { account_id: req.accountId, slug, title, bio, avatar_url: avatarUrl ?? null, updated_at: new Date().toISOString() },
        { onConflict: "account_id" },
      )
      .select()
      .single();
    if (error) {
      dbError(res, error, "PUT /bio-page");
      return;
    }
    res.json(data);
  });

  router.post("/bio-page/links", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { label, url } = req.body ?? {};
    if (typeof label !== "string" || label.trim().length === 0 || label.length > 80) {
      res.status(400).json({ error: "label must be a non-empty string, 80 characters or fewer" });
      return;
    }
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
      res.status(400).json({ error: "url must start with http:// or https://" });
      return;
    }

    const { data: page, error: pageError } = await supabase
      .from("bio_pages")
      .select("id")
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (pageError) {
      dbError(res, pageError, "POST /bio-page/links page lookup");
      return;
    }
    if (!page) {
      res.status(404).json({ error: "Set up your bio page first (PUT /bio-page) before adding links." });
      return;
    }

    const { count } = await supabase.from("bio_links").select("id", { count: "exact", head: true }).eq("bio_page_id", page.id);

    const { data, error } = await supabase
      .from("bio_links")
      .insert({ bio_page_id: page.id, label: label.trim(), url, position: count ?? 0 })
      .select()
      .single();
    if (error) {
      dbError(res, error, "POST /bio-page/links insert");
      return;
    }
    res.status(201).json(data);
  });

  router.patch("/bio-page/links/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { label, url, position } = req.body ?? {};
    const updates: Record<string, unknown> = {};
    if (label !== undefined) {
      if (typeof label !== "string" || label.trim().length === 0 || label.length > 80) {
        res.status(400).json({ error: "label must be a non-empty string, 80 characters or fewer" });
        return;
      }
      updates.label = label.trim();
    }
    if (url !== undefined) {
      if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
        res.status(400).json({ error: "url must start with http:// or https://" });
        return;
      }
      updates.url = url;
    }
    if (position !== undefined) {
      if (typeof position !== "number" || !Number.isInteger(position)) {
        res.status(400).json({ error: "position must be an integer" });
        return;
      }
      updates.position = position;
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    // A link only belongs to a page owned by this account — join through
    // bio_pages rather than trusting the link id alone, same ownership
    // discipline as every other per-resource route.
    const { data: link, error: linkError } = await supabase
      .from("bio_links")
      .select("id, bio_pages!inner(account_id)")
      .eq("id", req.params.id)
      .single();
    if (linkError || !link || (link.bio_pages as unknown as { account_id: string }).account_id !== req.accountId) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }

    const { data, error } = await supabase.from("bio_links").update(updates).eq("id", req.params.id).select().single();
    if (error) {
      dbError(res, error, "PATCH /bio-page/links/:id");
      return;
    }
    res.json(data);
  });

  router.delete("/bio-page/links/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: link, error: linkError } = await supabase
      .from("bio_links")
      .select("id, bio_pages!inner(account_id)")
      .eq("id", req.params.id)
      .single();
    if (linkError || !link || (link.bio_pages as unknown as { account_id: string }).account_id !== req.accountId) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }

    const { error } = await supabase.from("bio_links").delete().eq("id", req.params.id);
    if (error) {
      dbError(res, error, "DELETE /bio-page/links/:id");
      return;
    }
    res.status(204).send();
  });

  // Public rendering endpoint — no auth, this is what the actual bio page
  // (linked from a customer's Instagram/TikTok profile) fetches. Returns
  // only what's safe to show the public: no account_id, no internal ids
  // beyond what's needed for React keys.
  router.get("/public/bio/:slug", publicRateLimit, async (req, res) => {
    const { data: page, error } = await supabase
      .from("bio_pages")
      .select("id, slug, title, bio, avatar_url")
      .eq("slug", req.params.slug)
      .maybeSingle();
    if (error) {
      dbError(res, error, "GET /public/bio/:slug");
      return;
    }
    if (!page) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    const { data: links, error: linksError } = await supabase
      .from("bio_links")
      .select("id, label, url")
      .eq("bio_page_id", page.id)
      .order("position", { ascending: true });
    if (linksError) {
      dbError(res, linksError, "GET /public/bio/:slug links");
      return;
    }
    res.json({ title: page.title, bio: page.bio, avatarUrl: page.avatar_url, links: links ?? [] });
  });

  // Public Proof-of-Publish verification page — no auth, this is what
  // renders at lazyrelay.com/verify/:id when a customer shares the link
  // from GET /scheduled-posts/:id/proof-link. post_results.id doubles as
  // the public identifier (already a random UUID, same safety class as a
  // Stripe/Zoom link — no dedicated slug column needed, see migration
  // 0038_proof_link_sharing.sql). Returns 404 for both "doesn't exist" and
  // "exists but not verified live" — never distinguish the two, and never
  // include account_id, platform_post_id, or error_message.
  router.get("/public/verify/:id", publicRateLimit, async (req, res) => {
    const { data: result, error } = await supabase
      .from("post_results")
      .select(
        "verified_live, platform_post_url, verification_checked_at, scheduled_posts(content, scheduled_for, social_accounts(platform, display_name), accounts(business_name))"
      )
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) {
      dbError(res, error, "GET /public/verify/:id");
      return;
    }
    const post = result?.scheduled_posts as unknown as {
      content: string;
      scheduled_for: string;
      social_accounts: { platform: string; display_name: string | null } | null;
      accounts: { business_name: string | null } | null;
    } | null;
    if (!result || !result.verified_live || !post) {
      res.status(404).json({ error: "Nothing verified at this link." });
      return;
    }
    res.json({
      businessName: post.accounts?.business_name ?? null,
      platform: post.social_accounts?.platform ?? null,
      accountName: post.social_accounts?.display_name ?? null,
      content: post.content,
      scheduledFor: post.scheduled_for,
      verifiedAt: result.verification_checked_at,
      platformPostUrl: result.platform_post_url,
    });
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
  //
  // Bluesky/Telegram/Discord have no real OAuth redirect_uri — ConnectForm
  // hits this exact route via fetch() instead, with `?format=json`. A
  // redirect response is wrong for that caller: fetch() follows it
  // automatically, the hop lands on the frontend's origin, and that origin
  // (plain static hosting) sends no CORS headers — so the browser throws
  // "Failed to fetch" even though completeConnect() above already
  // succeeded and the account is genuinely connected (confirmed live
  // 2026-08-06: reproduced on Bluesky/Telegram/Discord, DB always correct,
  // only the fetch() call itself failed). `format=json` opts into a real
  // JSON response instead, without changing behavior for the real OAuth
  // platforms that still navigate the browser here directly.
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
  router.get("/social-accounts/callback", publicRateLimit, async (req, res) => {
    const { code, state } = req.query;
    const wantsJson = req.query.format === "json";
    if (typeof code !== "string" || typeof state !== "string") {
      const message = "Missing code or state";
      if (wantsJson) {
        res.status(400).json({ error: message });
        return;
      }
      res.redirect(`${frontendUrl}/?connectError=${encodeURIComponent(message)}`);
      return;
    }
    try {
      const socialAccountId = await completeConnect(state, code, registry);
      if (wantsJson) {
        res.json({ connected: true, socialAccountId });
        return;
      }
      res.redirect(`${frontendUrl}/?connected=1`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (wantsJson) {
        res.status(400).json({ error: message });
        return;
      }
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

  // Disconnecting was previously UI-only — there was no backend route at
  // all, so a customer who wanted to unlink an account (wrong account
  // connected, revoking access, switching accounts) had no way to actually
  // do it. Soft-delete via `disconnected_at`, the same reversible pattern
  // this table already uses everywhere else (GET /social-accounts already
  // filters on it) — not a hard delete, consistent with how the rest of
  // this schema treats "removed." The stored token itself is left in the
  // vault rather than actively revoked: none of the three manual platforms
  // (Bluesky app password, Telegram bot admin, Discord webhook) expose a
  // programmatic revoke, and the real OAuth platforms' tokens simply
  // become unreachable dead weight once this row stops being selectable —
  // same as every other soft-deleted row in this system.
  router.delete("/social-accounts/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error, count } = await supabase
      .from("social_accounts")
      .update({ disconnected_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .is("disconnected_at", null)
      .select()
      .maybeSingle();
    if (error) {
      dbError(res, error, "DELETE /social-accounts/:id");
      return;
    }
    if (!count || !data) {
      res.status(404).json({ error: "Not found, not owned by this caller, or already disconnected" });
      return;
    }
    res.status(204).end();
  });

  // Real board list for a connected account — drives the Pinterest board
  // picker in the compose form, replacing the adapter's own provisional
  // "whichever board comes back first" default with an actual customer
  // choice. Returns 200 with an empty array for any platform whose adapter
  // doesn't declare listBoards (i.e. every platform except Pinterest today)
  // rather than a 404/400 — "nothing to pick" is a legitimate response, not
  // an error, so the frontend doesn't need a platform allowlist of its own.
  router.get("/social-accounts/:id/boards", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: account, error } = await supabase
      .from("social_accounts")
      .select("account_id, platform, access_token_vault_id")
      .eq("id", req.params.id)
      .single();
    if (error || !account || account.account_id !== req.accountId) {
      res.status(403).json({ error: "Social account not found or not owned by this caller" });
      return;
    }

    const adapter = registry.get(account.platform);
    if (!adapter?.listBoards) {
      res.json([]);
      return;
    }

    const { data: accessToken, error: tokenError } = await supabase.rpc("read_social_token", {
      p_vault_id: account.access_token_vault_id,
    });
    if (tokenError || !accessToken) {
      res.status(500).json({ error: "Could not load this account's access token" });
      return;
    }

    const boards = await adapter.listBoards(accessToken as string);
    res.json(boards);
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
    input: { socialAccountId?: unknown; content?: unknown; mediaUrl?: unknown; coverImageUrl?: unknown; boardId?: unknown; firstComment?: unknown; scheduledFor?: unknown; requiresApproval?: unknown },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const { socialAccountId, content, mediaUrl, coverImageUrl, boardId, firstComment, scheduledFor, requiresApproval } = input;
    if (coverImageUrl !== undefined && coverImageUrl !== null && typeof coverImageUrl !== "string") {
      return { status: 400, body: { error: "coverImageUrl must be a string" } };
    }
    // Only meaningful for Pinterest today (see PostRequest.boardId), but
    // accepted/stored generically like coverImageUrl — every other
    // adapter's post() simply ignores it.
    if (boardId !== undefined && boardId !== null && typeof boardId !== "string") {
      return { status: 400, body: { error: "boardId must be a string" } };
    }
    // Only consumed by adapters that declare postComment (Facebook,
    // Instagram today) — every other adapter's post() simply ignores it,
    // same generic-column pattern as boardId/coverImageUrl.
    if (firstComment !== undefined && firstComment !== null && typeof firstComment !== "string") {
      return { status: 400, body: { error: "firstComment must be a string" } };
    }
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
        cover_image_url: coverImageUrl ?? null,
        board_id: boardId ?? null,
        first_comment: firstComment ?? null,
        scheduled_for: scheduledFor,
        // A post created with requiresApproval sits in needs_approval —
        // invisible to the scheduler (claimDuePosts only ever selects
        // status='pending') — until explicitly approved via
        // PATCH /scheduled-posts/:id/approve.
        status: requiresApproval === true ? "needs_approval" : "pending",
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

  const HISTORY_STATUSES = ["posted", "failed"];
  const SCHEDULED_POSTS_HISTORY_DEFAULT_LIMIT = 50;
  const SCHEDULED_POSTS_HISTORY_MAX_LIMIT = 100;

  // Bounded on purpose: this used to fetch a customer's ENTIRE post
  // history on every dashboard load, with the frontend only ever slicing
  // an already-fully-loaded array for "Load more" — a customer posting a
  // handful of times a day accumulates hundreds of rows within weeks, and
  // every page load kept getting slower forever. "Upcoming" posts
  // (pending/posting/needs_approval) are naturally small — they only
  // exist until they fire — so those are always returned in full. History
  // (posted/failed) is capped here to the most recent
  // SCHEDULED_POSTS_HISTORY_DEFAULT_LIMIT; anything older is fetched a
  // page at a time via GET /scheduled-posts/history.
  router.get("/scheduled-posts", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const [{ data: upcoming, error: upcomingError }, { data: history, error: historyError }] = await Promise.all([
      supabase
        .from("scheduled_posts")
        .select("*, post_results(*)")
        .eq("account_id", req.accountId)
        .in("status", ["pending", "posting", "needs_approval"])
        .order("scheduled_for", { ascending: true })
        // Now that every retry attempt (not just verification failures) can
        // leave its own post_results row, the frontend's `post_results?.[0]`
        // needs the MOST RECENT attempt first — without this, a post that
        // failed once and later succeeded on retry could still show its
        // stale first-attempt failure reason instead of the real outcome.
        .order("created_at", { ascending: false, referencedTable: "post_results" }),
      supabase
        .from("scheduled_posts")
        .select("*, post_results(*)")
        .eq("account_id", req.accountId)
        .in("status", HISTORY_STATUSES)
        .order("scheduled_for", { ascending: false })
        .order("created_at", { ascending: false, referencedTable: "post_results" })
        .limit(SCHEDULED_POSTS_HISTORY_DEFAULT_LIMIT),
    ]);
    if (upcomingError) {
      dbError(res, upcomingError, "GET /scheduled-posts upcoming");
      return;
    }
    if (historyError) {
      dbError(res, historyError, "GET /scheduled-posts history");
      return;
    }
    res.json([...(upcoming ?? []), ...(history ?? [])]);
  });

  // Additional pages of history, older than `before` (an ISO scheduled_for
  // timestamp — pass the oldest post currently loaded on the frontend).
  // Kept as its own endpoint rather than a page/offset param on the main
  // route above so "Upcoming" never has to be re-fetched just to see more
  // History.
  router.get("/scheduled-posts/history", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || SCHEDULED_POSTS_HISTORY_DEFAULT_LIMIT, 1), SCHEDULED_POSTS_HISTORY_MAX_LIMIT);
    const before = typeof req.query.before === "string" ? req.query.before : undefined;

    let query = supabase
      .from("scheduled_posts")
      .select("*, post_results(*)")
      .eq("account_id", req.accountId)
      .in("status", HISTORY_STATUSES)
      .order("scheduled_for", { ascending: false })
      .order("created_at", { ascending: false, referencedTable: "post_results" })
      .limit(limit);
    if (before) {
      query = query.lt("scheduled_for", before);
    }

    const { data, error } = await query;
    if (error) {
      dbError(res, error, "GET /scheduled-posts/history");
      return;
    }
    res.json(data ?? []);
  });

  // Social listening, in the only honest sense currently buildable: reading
  // comments/replies on posts LazyRelay itself published (via each
  // adapter's optional getComments — see the PlatformAdapter comment for
  // why full keyword/brand-mention search across public content isn't in
  // scope here). Mastodon/Bluesky/YouTube/Facebook/Instagram implement it;
  // every other platform's posts come back with supported:false rather
  // than a silently empty comment list, so the UI never implies broader
  // coverage than actually exists.
  router.get("/mentions", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: posts, error } = await supabase
      .from("scheduled_posts")
      .select("id, content, scheduled_for, social_account_id, social_accounts(platform), post_results(platform_post_id, platform_post_url, verified_live)")
      .eq("account_id", req.accountId)
      .eq("status", "posted")
      .order("scheduled_for", { ascending: false })
      .limit(15);
    if (error) {
      dbError(res, error, "GET /mentions");
      return;
    }

    const results: {
      postId: string;
      platform: string;
      content: string;
      scheduledFor: string;
      platformPostUrl: string | null;
      supported: boolean;
      canReply?: boolean;
      comments: (CommentItem & { triage?: TriageResult | null })[];
      errorMessage?: string | null;
    }[] = [];
    const commentTriageItems: TriageItem[] = [];
    for (const post of posts ?? []) {
      const platform = Array.isArray(post.social_accounts) ? post.social_accounts[0]?.platform : (post.social_accounts as { platform?: string } | null)?.platform;
      const results_ = Array.isArray(post.post_results) ? post.post_results : post.post_results ? [post.post_results] : [];
      const result = results_.find((r: { verified_live: boolean }) => r.verified_live);
      if (!platform || !result?.platform_post_id) continue;

      const adapter = registry.get(platform);
      if (!adapter || !adapter.getComments) {
        results.push({ postId: post.id, platform, content: post.content, scheduledFor: post.scheduled_for, platformPostUrl: result.platform_post_url, supported: false, comments: [] });
        continue;
      }

      try {
        const { data: account } = await supabase
          .from("social_accounts")
          .select("access_token_vault_id")
          .eq("id", post.social_account_id)
          .single();
        const { data: accessToken } = account
          ? await supabase.rpc("read_social_token", { p_vault_id: account.access_token_vault_id })
          : { data: null };
        if (!accessToken) {
          results.push({ postId: post.id, platform, content: post.content, scheduledFor: post.scheduled_for, platformPostUrl: result.platform_post_url, supported: true, comments: [], errorMessage: "Could not load this account's access token" });
          continue;
        }
        const commentsResult = await adapter.getComments(result.platform_post_id, accessToken as string);
        results.push({
          postId: post.id,
          platform,
          content: post.content,
          scheduledFor: post.scheduled_for,
          platformPostUrl: result.platform_post_url,
          supported: true,
          canReply: !!adapter.replyToComment,
          comments: commentsResult.comments,
          errorMessage: commentsResult.errorMessage,
        });
        commentTriageItems.push(
          ...commentsResult.comments.map((c) => ({ itemId: c.id, sourceSignature: c.id, author: c.author, text: c.text }))
        );
      } catch (err) {
        results.push({
          postId: post.id,
          platform,
          content: post.content,
          scheduledFor: post.scheduled_for,
          platformPostUrl: result.platform_post_url,
          supported: true,
          comments: [],
          errorMessage: err instanceof Error ? err.message : "Could not load comments",
        });
      }
    }

    // One batched Anthropic call for every not-yet-cached comment across
    // every post shown here, rather than one call per post — see
    // commentTriage.ts. Missing from the map means unclassified (no API
    // key configured, or the AI call failed), never treated as "routine".
    const triageMap = await triageItems(req.accountId!, "comment", commentTriageItems);
    for (const post of results) {
      post.comments = post.comments.map((c) => ({ ...c, triage: triageMap.get(c.id) ?? null }));
    }

    res.json({ posts: results });
  });

  // Reply to a comment surfaced by GET /mentions. postId is required (not
  // just commentId) so ownership can be checked the same way every other
  // account-scoped route does — a customer must own the post the comment
  // is attached to, never just supply an arbitrary commentId. Only
  // implemented for platforms whose adapter declares replyToComment
  // (Facebook, Instagram, Mastodon, Bluesky) — YouTube needs a new,
  // not-yet-requested scope (see PlatformAdapter's own comment).
  router.post("/mentions/reply", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { postId, commentId, text } = req.body as { postId?: string; commentId?: string; text?: string };
    if (!postId || !commentId || !text?.trim()) {
      res.status(400).json({ error: "postId, commentId, and text are all required" });
      return;
    }

    const { data: post, error: postError } = await supabase
      .from("scheduled_posts")
      .select("account_id, social_account_id, social_accounts(platform)")
      .eq("id", postId)
      .maybeSingle();
    if (postError) {
      dbError(res, postError, "POST /mentions/reply");
      return;
    }
    if (!post || post.account_id !== req.accountId) {
      res.status(404).json({ error: "Post not found" });
      return;
    }

    const platform = Array.isArray(post.social_accounts) ? post.social_accounts[0]?.platform : (post.social_accounts as { platform?: string } | null)?.platform;
    const adapter = platform ? registry.get(platform) : undefined;
    if (!adapter?.replyToComment) {
      res.status(400).json({ error: `Replying isn't supported on ${platform ?? "this platform"} yet` });
      return;
    }

    const { data: account } = await supabase
      .from("social_accounts")
      .select("access_token_vault_id")
      .eq("id", post.social_account_id)
      .single();
    const { data: accessToken } = account
      ? await supabase.rpc("read_social_token", { p_vault_id: account.access_token_vault_id })
      : { data: null };
    if (!accessToken) {
      res.status(500).json({ error: "Could not load this account's access token" });
      return;
    }

    const result = await adapter.replyToComment(commentId, text.trim(), accessToken as string);
    if (!result.success) {
      res.status(502).json({ error: result.errorMessage ?? "Reply failed" });
      return;
    }
    res.json({ success: true });
  });

  // DM inbox — priority (4) from the 2026-08-07 competitor audit. Only
  // Facebook and Instagram declare getConversations (new pages_messaging /
  // instagram_manage_messages permissions, added 2026-08-07 for exactly
  // this). Every other platform is silently skipped, not an error — this
  // list is additive across every DM-capable connected account, unlike
  // /mentions which is keyed off individual posts.
  router.get("/dms", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: accounts, error } = await supabase
      .from("social_accounts")
      .select("id, platform, display_name, access_token_vault_id")
      .eq("account_id", req.accountId)
      .is("disconnected_at", null);
    if (error) {
      dbError(res, error, "GET /dms");
      return;
    }

    const results: {
      socialAccountId: string;
      platform: string;
      accountDisplayName: string | null;
      conversationId: string;
      participantId: string;
      participantName: string;
      snippet: string | null;
      updatedAt: string | null;
      triage?: unknown;
    }[] = [];

    for (const account of accounts ?? []) {
      const adapter = registry.get(account.platform);
      if (!adapter?.getConversations) continue;

      const { data: accessToken } = await supabase.rpc("read_social_token", { p_vault_id: account.access_token_vault_id });
      if (!accessToken) continue;

      try {
        const convResult = await adapter.getConversations(accessToken as string);
        for (const c of convResult.conversations) {
          results.push({
            socialAccountId: account.id,
            platform: account.platform,
            accountDisplayName: account.display_name,
            conversationId: c.id,
            participantId: c.participantId,
            participantName: c.participantName,
            snippet: c.snippet,
            updatedAt: c.updatedAt,
          });
        }
      } catch (err) {
        // One platform's failure shouldn't take down the whole inbox — log
        // and move on rather than 500ing the entire request.
        console.error(`getConversations failed for ${account.platform}:`, err);
      }
    }

    results.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

    // Classified off the conversation's latest-message snippet, not the full
    // thread — same "surface the one that needs a human" scope as /mentions.
    // sourceSignature is updatedAt, so a new incoming message naturally
    // invalidates the cached classification instead of the DM going stale.
    const dmTriageItems: TriageItem[] = results
      .filter((r) => !!r.snippet)
      .map((r) => ({ itemId: r.conversationId, sourceSignature: r.updatedAt ?? "", author: r.participantName, text: r.snippet! }));
    const triageMap = await triageItems(req.accountId!, "dm", dmTriageItems);
    for (const r of results) {
      r.triage = triageMap.get(r.conversationId) ?? null;
    }

    res.json({ conversations: results });
  });

  router.get("/dms/messages", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const socialAccountId = req.query.socialAccountId as string | undefined;
    const conversationId = req.query.conversationId as string | undefined;
    if (!socialAccountId || !conversationId) {
      res.status(400).json({ error: "socialAccountId and conversationId are required" });
      return;
    }

    const { data: account, error } = await supabase
      .from("social_accounts")
      .select("account_id, platform, platform_account_id, access_token_vault_id")
      .eq("id", socialAccountId)
      .maybeSingle();
    if (error) {
      dbError(res, error, "GET /dms/messages");
      return;
    }
    if (!account || account.account_id !== req.accountId) {
      res.status(404).json({ error: "Social account not found" });
      return;
    }

    const adapter = registry.get(account.platform);
    if (!adapter?.getDirectMessages) {
      res.status(400).json({ error: `DMs aren't supported on ${account.platform}` });
      return;
    }

    const { data: accessToken } = await supabase.rpc("read_social_token", { p_vault_id: account.access_token_vault_id });
    if (!accessToken) {
      res.status(500).json({ error: "Could not load this account's access token" });
      return;
    }

    const result = await adapter.getDirectMessages(conversationId, accessToken as string);
    const messages = result.messages.map((m) => ({ ...m, isOwn: m.fromId === account.platform_account_id }));
    res.json({ messages, errorMessage: result.errorMessage });
  });

  router.post("/dms/reply", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { socialAccountId, recipientId, text } = req.body as { socialAccountId?: string; recipientId?: string; text?: string };
    if (!socialAccountId || !recipientId || !text?.trim()) {
      res.status(400).json({ error: "socialAccountId, recipientId, and text are all required" });
      return;
    }

    const { data: account, error } = await supabase
      .from("social_accounts")
      .select("account_id, platform, access_token_vault_id")
      .eq("id", socialAccountId)
      .maybeSingle();
    if (error) {
      dbError(res, error, "POST /dms/reply");
      return;
    }
    if (!account || account.account_id !== req.accountId) {
      res.status(404).json({ error: "Social account not found" });
      return;
    }

    const adapter = registry.get(account.platform);
    if (!adapter?.sendDirectMessage) {
      res.status(400).json({ error: `DMs aren't supported on ${account.platform}` });
      return;
    }

    const { data: accessToken } = await supabase.rpc("read_social_token", { p_vault_id: account.access_token_vault_id });
    if (!accessToken) {
      res.status(500).json({ error: "Could not load this account's access token" });
      return;
    }

    const result = await adapter.sendDirectMessage(recipientId, text.trim(), accessToken as string);
    if (!result.success) {
      res.status(502).json({ error: result.errorMessage ?? "Send failed" });
      return;
    }
    res.json({ success: true });
  });

  // DM automation — priority (5). CRUD only here; the actual comment
  // watching + sending happens in the standalone dmAutomationPoller.ts
  // script (same external-process pattern as metricsPoller.ts), not
  // in-process, so it keeps running on its own schedule independent of
  // the API server's lifecycle.
  router.post("/dm-automations", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { socialAccountId, scheduledPostId, keyword, dmMessage } = req.body as {
      socialAccountId?: string;
      scheduledPostId?: string | null;
      keyword?: string | null;
      dmMessage?: string;
    };
    if (!socialAccountId || !dmMessage?.trim()) {
      res.status(400).json({ error: "socialAccountId and dmMessage are required" });
      return;
    }

    const { data: account } = await supabase
      .from("social_accounts")
      .select("account_id, platform")
      .eq("id", socialAccountId)
      .maybeSingle();
    if (!account || account.account_id !== req.accountId) {
      res.status(404).json({ error: "Social account not found" });
      return;
    }
    const adapter = registry.get(account.platform);
    if (!adapter?.sendPrivateReply) {
      res.status(400).json({ error: `DM automation isn't supported on ${account.platform}` });
      return;
    }

    if (scheduledPostId) {
      const { data: post } = await supabase.from("scheduled_posts").select("account_id").eq("id", scheduledPostId).maybeSingle();
      if (!post || post.account_id !== req.accountId) {
        res.status(404).json({ error: "Post not found" });
        return;
      }
    }

    const { data, error } = await supabase
      .from("dm_automations")
      .insert({
        account_id: req.accountId,
        social_account_id: socialAccountId,
        scheduled_post_id: scheduledPostId ?? null,
        keyword: keyword?.trim() || null,
        dm_message: dmMessage.trim(),
      })
      .select("id, social_account_id, scheduled_post_id, keyword, dm_message, active, created_at")
      .single();
    if (error) {
      dbError(res, error, "POST /dm-automations");
      return;
    }
    res.status(201).json(data);
  });

  router.get("/dm-automations", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("dm_automations")
      .select("id, social_account_id, scheduled_post_id, keyword, dm_message, active, created_at, social_accounts(platform, display_name)")
      .eq("account_id", req.accountId)
      .order("created_at", { ascending: false });
    if (error) {
      dbError(res, error, "GET /dm-automations");
      return;
    }
    res.json(data ?? []);
  });

  router.delete("/dm-automations/:id", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: automation } = await supabase.from("dm_automations").select("account_id").eq("id", req.params.id).maybeSingle();
    if (!automation || automation.account_id !== req.accountId) {
      res.status(404).json({ error: "Automation not found" });
      return;
    }
    const { error } = await supabase.from("dm_automations").delete().eq("id", req.params.id);
    if (error) {
      dbError(res, error, "DELETE /dm-automations/:id");
      return;
    }
    res.status(204).end();
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
      .select(
        "id, status, scheduled_for, social_accounts(platform), post_results(verified_live, error_message), post_metrics(checkpoint, likes, comments, shares, views)"
      )
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

    // Real engagement analytics (2026-08-07) — additive to everything
    // above, never replacing it. Per post, use the single MOST MATURE
    // checkpoint available (30d beats 7d beats ... beats 1h) as that post's
    // current engagement — summing every checkpoint row would count the
    // same post's likes up to 6 times over, since checkpoints aren't
    // independent events. `postsWithData` is the honest denominator: how
    // many of this platform's posts actually have a number yet, since a
    // freshly-posted item or an unsupported platform contributes zero.
    const CHECKPOINT_MATURITY = ["30d", "7d", "3d", "24h", "6h", "1h"];
    const engagement: Record<
      string,
      { likes: number; comments: number; shares: number; views: number; postsWithData: number }
    > = {};

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

      type MetricRow = { checkpoint: string; likes: number | null; comments: number | null; shares: number | null; views: number | null };
      const metricRows: MetricRow[] = Array.isArray(row.post_metrics) ? row.post_metrics : row.post_metrics ? [row.post_metrics] : [];
      if (metricRows.length > 0) {
        const best = metricRows.reduce((a, b) =>
          CHECKPOINT_MATURITY.indexOf(a.checkpoint) <= CHECKPOINT_MATURITY.indexOf(b.checkpoint) ? a : b
        );
        engagement[platformKey] ??= { likes: 0, comments: 0, shares: 0, views: 0, postsWithData: 0 };
        engagement[platformKey].likes += best.likes ?? 0;
        engagement[platformKey].comments += best.comments ?? 0;
        engagement[platformKey].shares += best.shares ?? 0;
        engagement[platformKey].views += best.views ?? 0;
        engagement[platformKey].postsWithData += 1;
      }
    }

    res.json({
      rangeDays: days,
      totalPosts: data?.length ?? 0,
      byStatus,
      byPlatform,
      dailyCounts,
      verifiedLiveRate: postedCount > 0 ? verifiedLiveCount / postedCount : null,
      engagement,
    });
  });

  // Flips a needs_approval post to pending, making it eligible for the
  // scheduler. There's no separate "approver" role today (see
  // 0026_scheduled_posts_approval.sql) — anyone authenticated as this
  // account can approve, same as anyone can already edit/delete any post.
  router.patch("/scheduled-posts/:id/approve", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error, count } = await supabase
      .from("scheduled_posts")
      .update({ status: "pending" }, { count: "exact" })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .eq("status", "needs_approval")
      .select()
      .maybeSingle();
    if (error) {
      dbError(res, error, "PATCH /scheduled-posts/:id/approve");
      return;
    }
    if (!count || !data) {
      res.status(404).json({ error: "Not found, not owned by this caller, or not awaiting approval" });
      return;
    }
    res.json(data);
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

  // Generates the public Proof-of-Publish share link for a post. A human
  // dashboard session (JWT) can always do this — the frontend shows a
  // confirm dialog before calling it, since each share is a deliberate
  // one-off decision. A customer API key can only do it if that specific
  // key has can_share_proof set (opted in at creation, off by default) —
  // a genuine bring-your-own-agent automation path, not a standing default
  // power. See migration 0038_proof_link_sharing.sql.
  router.get("/scheduled-posts/:id/proof-link", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    if (req.authMethod === "apiKey" && !req.isAdmin && !req.apiKeyCanShareProof) {
      res.status(403).json({
        error: "This API key isn't permitted to generate proof-sharing links. Enable it for this key in your dashboard's API Keys settings.",
      });
      return;
    }

    const { data: result, error } = await supabase
      .from("post_results")
      .select("id, verified_live")
      .eq("scheduled_post_id", req.params.id)
      .eq("account_id", req.accountId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      dbError(res, error, "GET /scheduled-posts/:id/proof-link");
      return;
    }
    if (!result || !result.verified_live) {
      res.status(400).json({ error: "This post hasn't been verified live yet — nothing to share." });
      return;
    }
    res.json({ url: `${PUBLIC_SITE_URL}/verify/${result.id}` });
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
    coverImageUrl?: unknown;
    boardId?: unknown;
    firstComment?: unknown;
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
    if (input.coverImageUrl !== undefined && input.coverImageUrl !== null && typeof input.coverImageUrl !== "string") {
      return "coverImageUrl must be a string";
    }
    if (input.boardId !== undefined && input.boardId !== null && typeof input.boardId !== "string") {
      return "boardId must be a string";
    }
    if (input.firstComment !== undefined && input.firstComment !== null && typeof input.firstComment !== "string") {
      return "firstComment must be a string";
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
        cover_image_url: input.coverImageUrl ?? null,
        board_id: input.boardId ?? null,
        first_comment: input.firstComment ?? null,
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
      input.content === undefined && input.mediaUrl === undefined && input.coverImageUrl === undefined &&
      input.boardId === undefined && input.firstComment === undefined &&
      input.socialAccountIds === undefined &&
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
    if (input.coverImageUrl !== undefined) updates.cover_image_url = input.coverImageUrl;
    if (input.boardId !== undefined) updates.board_id = input.boardId;
    if (input.firstComment !== undefined) updates.first_comment = input.firstComment;
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
    const { data, error } = await supabase
      .from("accounts")
      .select("email, business_name, email_failure_alerts_enabled, webhook_url, webhook_secret")
      .eq("id", req.accountId)
      .single();
    if (error || !data) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    res.json({
      email: data.email,
      businessName: data.business_name,
      emailFailureAlertsEnabled: data.email_failure_alerts_enabled,
      webhookUrl: data.webhook_url,
      // Never the raw secret here — only whether one exists, so it isn't
      // repeated in every account fetch. Revealed once on the request that
      // sets/creates it, or via POST /account/webhook/regenerate-secret.
      webhookConfigured: !!data.webhook_secret,
    });
  });

  router.patch("/account", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { businessName, emailFailureAlertsEnabled, webhookUrl } = req.body ?? {};
    if (businessName !== undefined && businessName !== null && typeof businessName !== "string") {
      res.status(400).json({ error: "businessName must be a string or null" });
      return;
    }
    if (typeof businessName === "string" && businessName.length > 80) {
      res.status(400).json({ error: "businessName must be 80 characters or fewer" });
      return;
    }
    if (emailFailureAlertsEnabled !== undefined && typeof emailFailureAlertsEnabled !== "boolean") {
      res.status(400).json({ error: "emailFailureAlertsEnabled must be a boolean" });
      return;
    }
    if (webhookUrl !== undefined && webhookUrl !== null && typeof webhookUrl !== "string") {
      res.status(400).json({ error: "webhookUrl must be a string or null" });
      return;
    }
    // A leaked/compromised API key silently repointing the webhook would be
    // a persistent, ongoing exfiltration channel for every future verified
    // post — same escalation-risk shape as API key creation itself, so this
    // is human-dashboard-only, not something an agent can do headlessly.
    if (webhookUrl !== undefined && req.authMethod === "apiKey" && !req.isAdmin) {
      res.status(403).json({ error: "Webhook settings can only be changed from a logged-in dashboard session, not an API key." });
      return;
    }
    let newWebhookSecret: string | null = null;
    let normalizedWebhookUrl: string | null | undefined = undefined;
    if (typeof webhookUrl === "string") {
      const trimmed = webhookUrl.trim();
      if (trimmed.length === 0) {
        res.status(400).json({ error: "webhookUrl can't be empty, pass null to remove it" });
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        res.status(400).json({ error: "webhookUrl must be a valid URL" });
        return;
      }
      if (parsed.protocol !== "https:") {
        res.status(400).json({ error: "webhookUrl must use https" });
        return;
      }
      normalizedWebhookUrl = trimmed;
      const { data: existing } = await supabase.from("accounts").select("webhook_secret").eq("id", req.accountId).maybeSingle();
      if (!existing?.webhook_secret) newWebhookSecret = generateWebhookSecret();
    } else if (webhookUrl === null) {
      normalizedWebhookUrl = null;
    }

    const update: Record<string, unknown> = {};
    if (businessName !== undefined) update.business_name = businessName?.trim() || null;
    if (emailFailureAlertsEnabled !== undefined) update.email_failure_alerts_enabled = emailFailureAlertsEnabled;
    if (normalizedWebhookUrl !== undefined) {
      update.webhook_url = normalizedWebhookUrl;
      if (normalizedWebhookUrl === null) update.webhook_secret = null;
      else if (newWebhookSecret) update.webhook_secret = newWebhookSecret;
    }
    const { data, error } = await supabase
      .from("accounts")
      .update(update)
      .eq("id", req.accountId)
      .select("email, business_name, email_failure_alerts_enabled, webhook_url, webhook_secret")
      .single();
    if (error || !data) {
      dbError(res, error ?? { message: "update returned no row" }, "PATCH /account");
      return;
    }
    res.json({
      email: data.email,
      businessName: data.business_name,
      emailFailureAlertsEnabled: data.email_failure_alerts_enabled,
      webhookUrl: data.webhook_url,
      webhookConfigured: !!data.webhook_secret,
      // Only present the one time a secret is newly generated — same
      // "shown once, save it now" pattern as API key creation.
      ...(newWebhookSecret ? { webhookSecret: newWebhookSecret } : {}),
    });
  });

  // Lets a customer rotate a compromised/leaked webhook secret without
  // having to also change (and re-register with their own systems) the
  // webhook URL itself. Human-dashboard-only, same reasoning as the
  // webhookUrl check in PATCH /account above.
  router.post("/account/webhook/regenerate-secret", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: existing } = await supabase.from("accounts").select("webhook_url").eq("id", req.accountId).maybeSingle();
    if (!existing?.webhook_url) {
      res.status(400).json({ error: "Set a webhook URL first before generating a secret." });
      return;
    }
    const newSecret = generateWebhookSecret();
    const { error } = await supabase.from("accounts").update({ webhook_secret: newSecret }).eq("id", req.accountId);
    if (error) {
      dbError(res, error, "POST /account/webhook/regenerate-secret");
      return;
    }
    res.json({ webhookSecret: newSecret });
  });

  // API keys let a customer's own AI agent call this API directly and
  // headlessly (bring-your-own-agent — see tier.ts/pricing copy) instead of
  // needing a Supabase browser session, which by definition requires a
  // human to log in. Only requireAuth's Supabase-JWT path may create or
  // list keys — an agent authenticating WITH an API key can't mint more of
  // them, so a leaked key can't be used to self-escalate into permanent
  // access if the original key is later revoked.
  router.post("/api-keys", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { name, canShareProof } = req.body ?? {};
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
        // Off by default — a newly created (or later leaked) key can't
        // generate public proof-sharing links unless the customer
        // explicitly opted in at creation. See migration
        // 0038_proof_link_sharing.sql for the full reasoning.
        can_share_proof: canShareProof === true,
      })
      .select("id, name, key_prefix, can_share_proof, created_at")
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
      .select("id, name, key_prefix, can_share_proof, created_at, last_used_at, revoked_at")
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

  // Admin-only: list every account on the platform. Not scoped to req.accountId
  // at all — the whole point of an admin key is seeing across every tenant,
  // not acting as one. Logged via requireAuth's admin path like every other
  // admin-key request.
  router.get("/admin/accounts", requireAuth, requireAdmin, tieredRateLimit, async (_req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("accounts")
      .select("id, email, business_name, created_at, cancelled_at")
      .order("created_at", { ascending: false });
    if (error) {
      dbError(res, error, "GET /admin/accounts");
      return;
    }
    res.json(data);
  });

  // requireHumanAuth, not requireAdmin — this is the one place a real
  // Supabase login (never an API key, never the admin key itself) opens a
  // short window for the NEXT admin-key request to go through. See
  // migration 0037_admin_key_guard.sql and auth.ts's authorizeAdminRequest().
  router.post("/admin/announce", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const taskLabel = typeof req.body?.taskLabel === "string" ? req.body.taskLabel.slice(0, 500) : null;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error } = await supabase.from("admin_key_intents").insert({
      announced_by: req.accountId,
      task_label: taskLabel,
      expires_at: expiresAt,
    });
    if (error) {
      dbError(res, error, "POST /admin/announce");
      return;
    }
    res.json({ expiresAt, windowMinutes: 10 });
  });

  return router;
}
