import { Router, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import multer from "multer";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { imageSize } from "image-size";
import { fileTypeFromBuffer } from "file-type";
import { supabase } from "../supabase.js";
import { cancelSubscription, cancelStorageAddon, cancelBrandAddon, cancelSeatAddon } from "../billing/sync.js";
import { buildCheckoutTransaction } from "../billing/paddle.js";
import { Environment } from "@paddle/paddle-node-sdk";
import type { MerchantOfRecordAdapter } from "../billing/types.js";
import {
  startConnect,
  completeConnect,
  getPendingSelection,
  finalizeConnectSelection,
  type PlatformAdapterRegistry,
} from "../platforms/connect.js";
import { isGoogleCalendarConfigured } from "../googleCalendar/oauthClient.js";
import {
  startGoogleCalendarConnect,
  completeGoogleCalendarConnect,
  disconnectGoogleCalendar,
} from "../googleCalendar/connect.js";
import { syncPostToCalendar, deletePostFromCalendar } from "../googleCalendar/outboundSync.js";
import { syncConnectionInbound, type GoogleCalendarConnectionRow } from "../googleCalendar/inboundSync.js";
import {
  requireAuth,
  requireHumanAuth,
  requireAdmin,
  requireOwner,
  requireJwtUser,
  resolveOptionalAccountId,
  type AuthedRequest,
  API_KEY_PREFIX,
  hashApiKey,
} from "./auth.js";
import { tieredRateLimit, publicRateLimit } from "./rateLimit.js";
import {
  scheduleOnePost,
  validatePostFields,
  validateScheduledFor,
  checkFreeTierPostLimit,
  MAX_POST_CONTENT_LENGTH,
} from "../postCreation.js";
import { checkQuotaForNewUpload, getStorageUsage } from "../storageQuota.js";
import { checkAccountLimit } from "../accountLimits.js";
import { checkBrandLimit, getBrandCapacity } from "../brandLimits.js";
import { checkSeatLimit, getSeatCapacity, MAX_SEAT_ADDONS_PER_ACCOUNT } from "../seatLimits.js";
import { resolveTier, TIER_DISPLAY_NAMES, RECURRING_SCHEDULE_SLOT_LIMITS, type Tier } from "../tier.js";
import { cancelFuturePendingOccurrences } from "../recurringScheduler.js";
import { checkGenerationLimit, recordGeneration } from "../aiUsage.js";
import { buildSupportSystemPrompt, type SupportAccountContext } from "../support/chatKnowledge.js";
import { extractSelfReportedEmail, SELF_REPORTED_EMAIL } from "../support/escalationIdentity.js";
import { sendSupportEscalation, sendTeamInviteEmail, sendReviewFeedbackNotification } from "../email.js";
import { triageItems, type TriageItem, type TriageResult } from "../commentTriage.js";
import type { CommentItem } from "../platforms/types.js";
import { generateWebhookSecret } from "../webhook.js";
import { isSafeMediaUrl } from "../urlSafety.js";
import tls from "node:tls";

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

// Brand add-ons (Phase 1b, 2026-08-16) — one flat price, +1 brand slot each,
// ~$10/mo. Same abuse-prevention reasoning as MAX_ACTIVE_STORAGE_ADDONS: a
// customer legitimately running an agency-scale operation belongs on the
// future Agency tier, not stacking 50 add-ons on a self-serve plan.
const MAX_ACTIVE_BRAND_ADDONS = 10;
const BRAND_ADDON_PRICE_ID_ENV_VAR = "PADDLE_PRICE_ID_BRAND_ADDON";
const SEAT_ADDON_PRICE_ID_ENV_VAR = "PADDLE_PRICE_ID_SEAT_ADDON";
// Team invites (2026-08-17) -- no separate expires_at column; invited_at
// already exists and resend (POST /team/:id/resend) resets it, so the same
// timestamp doubles as "clock start" for both display and this check.
const TEAM_INVITE_EXPIRY_MS = 72 * 60 * 60 * 1000;

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

// Used to build the public Proof-of-Publish share link returned by
// GET /scheduled-posts/:id/proof-link (see migration
// 0038_proof_link_sharing.sql). No env var for this today — same fixed
// production domain every other public link in this codebase assumes.
const PUBLIC_SITE_URL = "https://lazyrelay.com";

// Real gap found in the 2026-08-25 pre-launch audit: /subscription/change-tier
// reads the current subscription, checks it's not already on the target
// tier, then calls Paddle's changeSubscriptionTier -- which charges a real,
// immediate prorated amount -- with no lock between the read and the charge.
// Two concurrent requests for the same account (a double-click, two open
// tabs, a client retry after a slow response) can both pass the check and
// both trigger a real Paddle charge; this is the exact failure class behind
// the real $59.97 unintended-charge incident on 2026-08-21. Single Render
// instance today (confirmed in the same audit), so a plain in-process lock
// is sufficient -- revisit with a DB-level lock (e.g. a Postgres advisory
// lock keyed on account_id) if this backend is ever scaled horizontally.
//
// 2026-09-01 audit fix: /subscription/checkout had the exact same
// check-then-act shape and no lock at all -- a double-click or two open
// tabs on Free-to-paid checkout could create TWO independent Paddle
// subscriptions, both actually charged, with the local row only ever
// tracking one (onConflict: account_id) -- the other bills the customer
// indefinitely with no way for the app or the customer to see or cancel it.
// Reusing this same set for both routes is correct: both represent "this
// account has an in-flight subscription-lifecycle mutation," and there's no
// legitimate reason to allow a checkout and a change-tier to race each
// other either.
const pendingTierChanges = new Set<string>();

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
// "google-business" is also comingSoon: true, added 2026-08-17 — the
// adapter is code-complete (platforms/googleBusiness.ts) but has never been
// tested against a real API response, and Google Business Profile APIs are
// fully gated: the API isn't even visible in the Cloud Console until Google
// approves a separate access-request form, a stricter gate than a standard
// OAuth-scope review. Real credentials + the access-request approval are
// both required before this can go live for any customer.
const ALL_PLATFORMS = [
  "tiktok", "pinterest", "youtube", "mastodon", "bluesky", "telegram",
  "linkedin", "threads", "facebook", "instagram", "discord", "tumblr", "x",
  "snapchat", "google-business",
] as const;
const COMING_SOON_PLATFORMS = new Set<string>(["snapchat", "x", "google-business"]);

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

  // Brand voice for AI captions/hashtags (migration 0061, 2026-08-20) — a
  // brand-specific voice_profile beats the account-level default, since
  // that's the whole point of the per-brand override for agencies/multi-
  // business owners; neither is required, so most customers who never
  // touch either setting see no change in behavior. socialAccountId is
  // optional and re-verified against the caller's own account here (never
  // trusted from the client beyond "which account is this for") — a
  // mismatched or foreign id just falls through to the account default
  // rather than erroring, since a missing voice is not a failure case.
  async function resolveVoiceProfile(accountId: string, socialAccountId: unknown): Promise<string | null> {
    if (typeof socialAccountId === "string" && socialAccountId) {
      const { data: social } = await supabase
        .from("social_accounts")
        .select("brand_id, account_id")
        .eq("id", socialAccountId)
        .maybeSingle();
      if (social && social.account_id === accountId && social.brand_id) {
        const { data: brand } = await supabase.from("brands").select("voice_profile").eq("id", social.brand_id).maybeSingle();
        if (brand?.voice_profile?.trim()) return brand.voice_profile.trim();
      }
    }
    const { data: account } = await supabase.from("accounts").select("voice_profile").eq("id", accountId).maybeSingle();
    return account?.voice_profile?.trim() || null;
  }

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
    const { topic, platform, tone, socialAccountId } = req.body ?? {};
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

    const voiceProfile = await resolveVoiceProfile(req.accountId!, socialAccountId);
    const voiceBlock = voiceProfile ? `Match this brand's voice: ${voiceProfile}\n\n` : "";

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
              voiceBlock +
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
    const { content, platform, socialAccountId } = req.body ?? {};
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

    const voiceProfile = await resolveVoiceProfile(req.accountId!, socialAccountId);
    const voiceBlock = voiceProfile ? `This brand's voice: ${voiceProfile}\n\n` : "";

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
              voiceBlock +
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

  // Content coach (2026-08-08) — item 6 from the 2026-08-07 competitor
  // audit's "my own ideas" list: every competitor researched assumes the
  // customer already knows what to post; this closes the actual "I don't
  // know what to say" gap one step before /ai/caption, which needs a topic
  // to already exist. Same optional-integration gate as the other two AI
  // routes, and shares their daily generation quota (checkGenerationLimit) —
  // this is still a customer-initiated "generate" action, not a background
  // enhancement like the comment-triage classifier.
  router.post("/ai/content-ideas", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "AI content ideas aren't set up on this deploy yet." });
      return;
    }

    const limitReason = await checkGenerationLimit(req.accountId!);
    if (limitReason) {
      res.status(429).json({ error: limitReason });
      return;
    }

    const { data: account } = await supabase.from("accounts").select("business_name").eq("id", req.accountId).maybeSingle();
    const { data: recentPosts } = await supabase
      .from("scheduled_posts")
      .select("content")
      .eq("account_id", req.accountId)
      .order("created_at", { ascending: false })
      .limit(10);

    const businessLabel = account?.business_name?.trim() ? `a small business called "${account.business_name.trim()}"` : "a small business";
    const recentTopicsBlock =
      recentPosts && recentPosts.length > 0
        ? `Their recent posts, so you can stay fresh and not repeat these topics:\n${recentPosts.map((p) => `- ${p.content.slice(0, 200)}`).join("\n")}\n\n`
        : "";

    try {
      // Same timeout reasoning as /ai/caption and /ai/hashtags above.
      const client = new Anthropic({ apiKey, timeout: 20_000 });
      const message = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content:
              `You're a social media content coach for ${businessLabel}. ${recentTopicsBlock}` +
              `Suggest 5 fresh post ideas for what they could post next. Each idea is a short one-sentence hook or topic ` +
              `(not a full caption) — vary the type across the 5 (e.g. behind the scenes, a tip, a customer story, a product/service highlight, a timely or seasonal angle).\n\n` +
              `Return ONLY a JSON array of exactly 5 strings, no other text.`,
          },
        ],
      });
      const textBlock = message.content.find((block) => block.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        res.status(502).json({ error: "AI content ideas returned no usable text." });
        return;
      }
      const match = textBlock.text.match(/\[[\s\S]*\]/);
      const parsed = match ? JSON.parse(match[0]) : null;
      if (!Array.isArray(parsed) || parsed.some((idea) => typeof idea !== "string")) {
        res.status(502).json({ error: "AI content ideas returned an unexpected format." });
        return;
      }
      await recordGeneration(req.accountId!);
      res.json({ ideas: parsed as string[] });
    } catch (err) {
      console.error("[routes] POST /ai/content-ideas:", err instanceof Error ? err.message : err);
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        res.status(504).json({ error: "AI content ideas took too long, please try again." });
        return;
      }
      res.status(502).json({ error: "AI content ideas failed, please try again." });
    }
  });

  // AI support widget (2026-08-10) — public, no requireAuth, since it has
  // to work for signed-out visitors on the marketing site as well as
  // logged-in dashboard users. Reuses publicRateLimit (IP-keyed) for now;
  // unlike the OAuth callback that limiter was built for, this route costs
  // real Anthropic spend per call, so tighten this if real usage shows
  // it's too generous.
  //
  // Account-aware, Phase 1 (2026-08-11) — read-only. resolveOptionalAccountId
  // is the ONLY source of truth for whose data gets fetched; it verifies a
  // real Supabase JWT server-side, same trust boundary as requireAuth, so
  // there is no path for a client to claim to be a different account. A
  // missing/invalid token just means anonymous (identical to the original
  // v1 behavior) — this never turns into a 401, since the widget must keep
  // working for signed-out visitors.
  async function fetchSupportAccountContext(accountId: string): Promise<SupportAccountContext | null> {
    try {
      // getStorageUsage already resolves tier internally (and its
      // quotaBytes already folds in any purchased storage add-ons) — reuse
      // its result rather than calling resolveTier a second time.
      const [{ data: accounts }, { data: recentFailed }, storage] = await Promise.all([
        supabase.from("social_accounts").select("id, platform").eq("account_id", accountId).is("disconnected_at", null),
        supabase
          .from("scheduled_posts")
          .select("platform, post_results(error_message)")
          .eq("account_id", accountId)
          .eq("status", "failed")
          .order("scheduled_for", { ascending: false })
          .order("created_at", { ascending: false, referencedTable: "post_results" })
          .limit(3),
        getStorageUsage(accountId),
      ]);
      return {
        tierDisplayName: TIER_DISPLAY_NAMES[storage.tier],
        connectedPlatforms: (accounts ?? []).map((a) => ({ id: a.id, platform: a.platform })),
        recentFailures: (recentFailed ?? []).map((p: { platform: string; post_results: { error_message: string | null }[] }) => ({
          platform: p.platform,
          error: p.post_results?.[0]?.error_message ?? "unspecified error",
        })),
        storageUsedBytes: storage.usedBytes,
        storageQuotaBytes: storage.quotaBytes,
      };
    } catch (err) {
      // Never let an enrichment failure break the actual chat reply — same
      // fire-and-forget-safety reasoning as the knowledge-gap logging below.
      console.error("[routes] fetchSupportAccountContext:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  // Tightened from 20 (2026-08-19, security review) — Werner's own bar for
  // this bot: if it can't resolve something in 5-8 replies, something's
  // wrong with the bot, not the customer. 16 messages = 8 user turns + 8
  // replies, matching the top of that range rather than the more generous
  // original limit.
  const MAX_CHAT_MESSAGES = 16;
  // Global backstop across EVERY conversation combined, not per-visitor —
  // this route costs real Anthropic spend per call and has no daily total
  // otherwise (publicRateLimit is per-IP-per-minute only, easily multiplied
  // across many source IPs). At today's near-zero real traffic this should
  // never actually trigger; it exists purely to cap a scripted abuse
  // attempt. See increment_support_chat_usage in migration 0056.
  const SUPPORT_CHAT_DAILY_CAP = 500;
  const MAX_CHAT_MESSAGE_LENGTH = 2000;
  // SELF_REPORTED_EMAIL and extractSelfReportedEmail live in
  // support/escalationIdentity.ts -- pure, and covered by test-support-chat.ts.

  // Recognises OUR OWN contact ask (chatKnowledge.ts:177 tells the model to ask
  // for both a name and an email), so a customer's reply to it -- handover or
  // refusal -- isn't mistaken for their question. Deliberately requires the two
  // words together: a reply that merely mentions email (failure alerts, say)
  // must not match, or a real question would get skipped.
  const ASKED_FOR_CONTACT = /name and (?:an? )?email|email and (?:your )?name/i;
  router.post("/support/chat", publicRateLimit, async (req, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "The support assistant isn't set up on this deploy yet." });
      return;
    }
    const { messages } = req.body ?? {};
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_CHAT_MESSAGES) {
      res.status(400).json({ error: `messages must be a non-empty array of at most ${MAX_CHAT_MESSAGES} items` });
      return;
    }
    const validRoles = new Set(["user", "assistant"]);
    for (const m of messages) {
      if (
        typeof m !== "object" ||
        m === null ||
        !validRoles.has(m.role) ||
        typeof m.content !== "string" ||
        m.content.length === 0 ||
        m.content.length > MAX_CHAT_MESSAGE_LENGTH
      ) {
        res.status(400).json({ error: "each message needs a role of user/assistant and non-empty content" });
        return;
      }
    }
    if (messages[messages.length - 1].role !== "user") {
      res.status(400).json({ error: "the last message must be from the user" });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const { data: withinDailyCap, error: usageError } = await supabase.rpc("check_and_increment_support_chat_usage", {
      p_usage_date: today,
      p_daily_cap: SUPPORT_CHAT_DAILY_CAP,
    });
    if (usageError) {
      dbError(res, usageError, "POST /support/chat daily cap check");
      return;
    }
    if (!withinDailyCap) {
      res.status(429).json({
        error: "The support assistant has hit its limit for today — please email support instead, or try again tomorrow.",
      });
      return;
    }

    try {
      const accountId = await resolveOptionalAccountId(req);
      const accountContext = accountId ? await fetchSupportAccountContext(accountId) : null;

      // Longer timeout than the caption/hashtag routes — this is a real
      // conversational reply grounded in a much bigger system prompt, not a
      // short generation. Still bounded so a hung call fails cleanly.
      const client = new Anthropic({ apiKey, timeout: 30_000 });
      const message = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 500,
        system: buildSupportSystemPrompt(accountContext),
        messages: messages.map((m: { role: "user" | "assistant"; content: string }) => ({ role: m.role, content: m.content })),
      });
      const textBlock = message.content.find((block) => block.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        res.status(502).json({ error: "The support assistant returned no usable reply." });
        return;
      }

      const escalateMatch = textBlock.text.match(/\[\[ESCALATE:(hello|support|accounts)\]\]/);
      // accountContext-gated: the prompt only ever offers action tags to a
      // verified logged-in conversation, but guard here too rather than
      // trust the model's own restraint alone — an anonymous request must
      // never produce an action, defense in depth on top of prompt design.
      const actionMatch = accountContext
        ? textBlock.text.match(/\[\[ACTION:(reconnect:[a-z]+|disconnect:[a-z]+:[0-9a-f-]+|cancel_subscription)\]\]/)
        : null;
      const reply = textBlock.text
        .replace(/\s*\[\[ESCALATE:(hello|support|accounts)\]\]\s*$/, "")
        .replace(/\s*\[\[ACTION:[^\]]+\]\]\s*$/, "")
        .trim();
      const escalated = escalateMatch ? (escalateMatch[1] as "hello" | "support" | "accounts") : null;

      let action:
        | { type: "reconnect"; platform: string }
        | { type: "disconnect"; platform: string; accountId: string }
        | { type: "cancel_subscription" }
        | null = null;
      if (actionMatch) {
        const raw = actionMatch[1];
        if (raw === "cancel_subscription") {
          action = { type: "cancel_subscription" };
        } else if (raw.startsWith("reconnect:")) {
          action = { type: "reconnect", platform: raw.slice("reconnect:".length) };
        } else if (raw.startsWith("disconnect:")) {
          const [, platform, id] = raw.split(":");
          action = { type: "disconnect", platform, accountId: id };
        }
      }

      if (escalated) {
        const conversationTranscript = [...messages.map((m: { role: string; content: string }) => `${m.role}: ${m.content}`), `assistant: ${reply}`].join("\n\n");

        // Real gap found live 2026-08-11: escalations carried no way to
        // identify the customer, so a genuine vendor-security-review lead
        // was undeliverable ("the team will email you back" on a channel
        // with no address to reply to). Fixed for logged-in customers,
        // where we already have a verified accountId -- fetched only here,
        // never exposed to the model itself, since it has no legitimate
        // need for a customer's email to answer a question. Anonymous
        // visitors still have no captured address; that's a real product
        // decision (ask for one during escalation?), not a bug this fixes.
        let customerLine = "Customer: anonymous visitor, no email captured (not logged in).";
        if (accountId) {
          const { data: acct } = await supabase.from("accounts").select("email").eq("id", accountId).maybeSingle();
          customerLine = acct?.email
            ? `Customer: ${acct.email} (logged in, account ${accountId})`
            : `Customer: logged in, account ${accountId}, but no email on file`;
        } else {
          // No verified session, but the model may have asked for and been
          // given a self-reported name/email in this same conversation (see
          // chatKnowledge.ts's contactCaptureLine) -- surface it here too, so
          // a human skimming just this header line doesn't miss contact info
          // that's actually present a few lines down in the transcript.
          //
          // USER turns only, and never our own address: scanning the whole
          // transcript reported the assistant's own "email support@lazyrelay.com"
          // back as the customer's address (found live 2026-08-17, support@ uid 33).
          const selfReportedEmail = extractSelfReportedEmail(messages);
          if (selfReportedEmail) {
            customerLine = `Customer: anonymous visitor, no verified session, but self-reported "${selfReportedEmail}" appears in the conversation below -- read the full transcript to confirm name/email before replying.`;
          }
        }
        const transcript = `${customerLine}\n\n${conversationTranscript}`;
        sendSupportEscalation(escalated, transcript);

        // Feeds the weekly knowledge-gap digest (see support_knowledge_gaps,
        // migration 0044) — every escalation is a signal the knowledge base
        // is missing something, not just a one-off email. Fire-and-forget,
        // same as the email above: never let a logging failure affect the
        // customer-visible reply.
        //
        // question_summary must be the customer's actual question, not the
        // forced name/email reply an anonymous visitor gives right before
        // escalation (chatKnowledge.ts:177) -- found live 2026-08-17. For an
        // anonymous, multi-turn escalation the last user turn is that
        // contact-details reply, so walk back one turn to the real question;
        // logged-in customers never hit the forced contact turn, so their
        // last message already is the question.
        //
        // Walking back is gated on evidence that the last turn really IS the
        // contact-details turn, not on position alone: chatKnowledge.ts:177
        // also tells the model to escalate WITHOUT capturing contact when a
        // visitor declines or just repeats themselves, and it can simply not
        // ask. There the last turn is the real question, and an unconditional
        // walk-back would store an earlier, unrelated one -- swapping a loud
        // failure (obvious contact details in the column) for a quiet one (a
        // plausible-looking wrong question nobody would catch).
        //
        // Two signals, because the customer's reply to the contact ask can be
        // either a handover ("Sam, sam@x.com") or a refusal ("no thanks") and
        // only the first carries an email. The refusal is caught by looking at
        // what WE asked on the preceding turn instead -- our own generated
        // text, a far more reliable thing to match on than the customer's.
        const userMessages = messages.filter((m: { role: string; content: string }) => m.role === "user");
        const lastUserMessage = userMessages[userMessages.length - 1]?.content ?? "";
        const previousTurn = messages[messages.length - 2];
        const askedForContact =
          previousTurn?.role === "assistant" && ASKED_FOR_CONTACT.test(previousTurn.content);
        const questionSummary =
          !accountId &&
          userMessages.length > 1 &&
          (SELF_REPORTED_EMAIL.test(lastUserMessage) || askedForContact)
            ? userMessages[userMessages.length - 2].content
            : lastUserMessage;

        supabase
          .from("support_knowledge_gaps")
          .insert({
            escalation_category: escalated,
            question_summary: questionSummary.slice(0, 500),
            transcript,
          })
          .then(({ error }) => {
            if (error) console.error("[routes] support_knowledge_gaps insert:", error.message);
          });
      }

      res.json({ reply, escalated, action });
    } catch (err) {
      console.error("[routes] POST /support/chat:", err instanceof Error ? err.message : err);
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        res.status(504).json({ error: "The support assistant took too long — please try again." });
        return;
      }
      res.status(502).json({ error: "The support assistant failed — please try again." });
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

  // Prefixes reserved for LazyRelay's own family of names (Werner,
  // 2026-08-30) — a customer picking "Lazy..." would both collide with our
  // own brand and undercut the whole point of unique names (support/agents
  // still can't tell accounts apart at a glance). Checked separately from,
  // and before, the uniqueness lookup below — no numeric-suffix suggestion
  // makes sense for a reserved word, since "Lazy Co 2" is just as reserved.
  const RESERVED_BUSINESS_NAME_PREFIXES = ["lazy"];
  function isReservedBusinessName(name: string): boolean {
    const lower = name.toLowerCase();
    return RESERVED_BUSINESS_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix));
  }

  // Public, pre-signup availability check (2026-08-30) — no auth exists yet
  // at this point (see AuthContext.tsx's signUp), so this can't be a
  // duplicate-name check on an authed route the way PATCH /account's is.
  // Reads every non-null business_name once and compares in JS rather than
  // one query per candidate — at LazyRelay's actual account volume this is
  // a single small text column, not worth the fragility of building a
  // PostgREST OR-filter string out of untrusted, possibly comma/paren-
  // containing business names. Suggestions are plain numeric suffixes,
  // capped at 80 chars total to match the field's own limit.
  router.post("/public/signup/check-business-name", publicRateLimit, async (req, res) => {
    const raw = typeof req.body?.businessName === "string" ? req.body.businessName.trim() : "";
    if (!raw) {
      res.json({ available: true });
      return;
    }
    if (raw.length > 80) {
      res.status(400).json({ error: "businessName must be 80 characters or fewer" });
      return;
    }
    if (/[\r\n]/.test(raw)) {
      res.status(400).json({ error: "businessName can't contain line breaks" });
      return;
    }
    if (isReservedBusinessName(raw)) {
      res.json({ available: false, reason: "reserved" });
      return;
    }
    const { data, error } = await supabase.from("accounts").select("business_name").not("business_name", "is", null);
    if (error) {
      dbError(res, error, "POST /public/signup/check-business-name");
      return;
    }
    const taken = new Set((data ?? []).map((row) => (row.business_name as string).toLowerCase()));
    if (!taken.has(raw.toLowerCase())) {
      res.json({ available: true });
      return;
    }
    const suggestions: string[] = [];
    for (let n = 2; n <= 6 && suggestions.length < 3; n++) {
      const suffix = ` ${n}`;
      const base = raw.length + suffix.length > 80 ? raw.slice(0, 80 - suffix.length) : raw;
      const candidate = `${base}${suffix}`;
      if (!taken.has(candidate.toLowerCase())) suggestions.push(candidate);
    }
    res.json({ available: false, reason: "taken", suggestions });
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

  // Public review-feedback form — no auth, reached from the review-request
  // email's link (Template 12 in EMAIL_REPLY_TEMPLATES.md). token doubles
  // as the sole authorization, same pattern as post_results.id above and
  // account_members.invite_token (migration 0053) — a random uuid Postgres
  // generates on insert, not app code. Werner's call 2026-08-21: replace
  // "reply to this email" with a real 5-question star-rating form + an
  // optional comment box (migration 0063).
  router.get("/public/feedback/:token", publicRateLimit, async (req, res) => {
    const { data: row, error } = await supabase
      .from("review_feedback")
      .select("submitted_at")
      .eq("token", req.params.token)
      .maybeSingle();
    if (error) {
      dbError(res, error, "GET /public/feedback/:token");
      return;
    }
    if (!row) {
      res.status(404).json({ error: "This feedback link isn't valid." });
      return;
    }
    res.json({ alreadySubmitted: !!row.submitted_at });
  });

  // Column name -> the same question wording shown on FeedbackForm.tsx, for
  // the internal notification email's ratings summary.
  const FEEDBACK_QUESTION_LABELS = [
    ["rating_overall", "Overall satisfaction:"],
    ["rating_reliability", "Reliability:"],
    ["rating_ease", "Ease of getting started:"],
    ["rating_support", "Support:"],
    ["rating_recommend", "Likelihood to recommend:"],
  ] as const;

  router.post("/public/feedback/:token", publicRateLimit, async (req, res) => {
    const ratingFields = [
      ["ratingOverall", "rating_overall"],
      ["ratingReliability", "rating_reliability"],
      ["ratingEase", "rating_ease"],
      ["ratingSupport", "rating_support"],
      ["ratingRecommend", "rating_recommend"],
    ] as const;

    const update: Record<string, unknown> = { submitted_at: new Date().toISOString() };
    for (const [bodyKey, column] of ratingFields) {
      const value = req.body?.[bodyKey];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
        res.status(400).json({ error: `${bodyKey} must be an integer from 1 to 5.` });
        return;
      }
      update[column] = value;
    }
    const comment = typeof req.body?.comment === "string" ? req.body.comment.trim().slice(0, 2000) : null;
    update.comment = comment || null;

    const { data: existing, error: fetchError } = await supabase
      .from("review_feedback")
      .select("id, submitted_at")
      .eq("token", req.params.token)
      .maybeSingle();
    if (fetchError) {
      dbError(res, fetchError, "POST /public/feedback/:token fetch");
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "This feedback link isn't valid." });
      return;
    }
    if (existing.submitted_at) {
      res.status(409).json({ error: "This feedback link has already been used." });
      return;
    }

    const { error: updateError } = await supabase.from("review_feedback").update(update).eq("id", existing.id);
    if (updateError) {
      dbError(res, updateError, "POST /public/feedback/:token update");
      return;
    }
    // Werner's call 2026-08-21: one click and it's genuinely delivered to
    // us, no further action needed from the customer — this real email to
    // hello@lazyrelay.com IS the delivery, not just a courtesy copy.
    const ratingsSummary = FEEDBACK_QUESTION_LABELS.map(([column, label]) => `${label} ${update[column]}/5`).join("\n");
    sendReviewFeedbackNotification(ratingsSummary, comment);
    res.json({ ok: true });
  });

  // Public status endpoint — no auth, deliberately narrow: only the signals
  // a customer actually needs (is the scheduler running on time, is the
  // site's certificate healthy), never business-sensitive numbers like MAU
  // or DB size — those stay internal-ops-only (see ops/health/health_ops.js,
  // whose real scheduler-lag query this reuses, translated to TS).
  router.get("/public/status", publicRateLimit, async (_req, res) => {
    const graceMinutes = 5;
    const cutoff = new Date(Date.now() - graceMinutes * 60 * 1000).toISOString();
    const { count, error } = await supabase
      .from("scheduled_posts")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .lt("scheduled_for", cutoff);
    if (error) {
      dbError(res, error, "GET /public/status");
      return;
    }
    const overdueCount = count ?? 0;
    const schedulerStatus = overdueCount >= 5 ? "delayed" : overdueCount >= 1 ? "watching" : "ok";

    const ssl = await new Promise<{ status: string; daysRemaining: number | null }>((resolve) => {
      const socket = tls.connect(
        { host: "lazyrelay.com", port: 443, servername: "lazyrelay.com", timeout: 15000 },
        () => {
          const cert = socket.getPeerCertificate();
          socket.end();
          if (!cert || !cert.valid_to) {
            resolve({ status: "unknown", daysRemaining: null });
            return;
          }
          const daysRemaining = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / (24 * 3600 * 1000));
          resolve({ status: daysRemaining <= 7 ? "critical" : daysRemaining <= 14 ? "warn" : "ok", daysRemaining });
        }
      );
      socket.on("error", () => resolve({ status: "unknown", daysRemaining: null }));
      socket.on("timeout", () => {
        socket.destroy();
        resolve({ status: "unknown", daysRemaining: null });
      });
    });

    const overall = schedulerStatus === "delayed" || ssl.status === "critical" ? "degraded" : "operational";

    res.json({
      overall,
      checkedAt: new Date().toISOString(),
      scheduler: { status: schedulerStatus, overdueCount },
      ssl,
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
      const { url, stateId } = await startConnect(req.accountId!, platform, registry);
      // Binds this specific browser to this specific state token — without
      // it, the state row alone only proves which ACCOUNT started the
      // flow, not which browser, so an attacker could mint this URL for
      // themselves and hand it to a victim: the victim clicks "Allow" on
      // the real platform, and completeConnect() would otherwise happily
      // link the victim's real social account into the attacker's
      // LazyRelay account. The callback below requires this same cookie
      // to be present and match. 15 minutes, matching oauth_states'
      // own expiry (see migration 0004).
      res.cookie("lr_oauth_state", stateId, {
        httpOnly: true,
        secure: true,
        // "none", not "lax": the frontend and backend are different origins
        // (see app.ts's allowedOrigins), so this cookie is set via a
        // cross-origin fetch() and — for Bluesky/Telegram/Discord, which
        // never leave the page — read back via another cross-origin
        // fetch() too, not a top-level navigation. Lax would only survive
        // the real-OAuth-platform redirect path and silently break those
        // three. Requires Secure, already set above.
        sameSite: "none",
        maxAge: 15 * 60_000,
      });
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
    // Requires the same browser that started the connect flow (and got
    // handed the lr_oauth_state cookie in the /social-accounts/connect
    // response) to be the one completing it — the state row alone proves
    // which account started the flow, not which browser, which is what a
    // forged/shared authorize link could otherwise exploit. Cleared either
    // way, since this cookie is one-time-use just like the state row.
    const cookieState = req.cookies?.lr_oauth_state;
    res.clearCookie("lr_oauth_state", { httpOnly: true, secure: true, sameSite: "none" });
    if (cookieState !== state) {
      const message = "This connect link wasn't opened in the same browser it was started in — please try connecting again.";
      if (wantsJson) {
        res.status(403).json({ error: message });
        return;
      }
      res.redirect(`${frontendUrl}/?connectError=${encodeURIComponent(message)}`);
      return;
    }
    try {
      const result = await completeConnect(state, code, registry);
      if (result.status === "needs_selection") {
        if (wantsJson) {
          res.json({ connected: false, needsSelection: true, selectionToken: result.selectionToken });
          return;
        }
        res.redirect(`${frontendUrl}/?selectAccount=${encodeURIComponent(result.selectionToken)}`);
        return;
      }
      if (wantsJson) {
        res.json({ connected: true, socialAccountId: result.socialAccountId });
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

  // Real Page/account picker, for adapters where one OAuth login can map to
  // several destinations (Facebook: multiple Pages; Instagram: whichever
  // Page has a Business Account linked) — see connect.ts. requireAuth here
  // is real defense-in-depth on top of getPendingSelection's own
  // account-ownership check, not the only thing enforcing it.
  router.get("/social-accounts/pending-selection/:token", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { token } = req.params;
    if (typeof token !== "string") {
      res.status(400).json({ error: "token is required" });
      return;
    }
    try {
      const pending = await getPendingSelection(token, req.accountId);
      res.json(pending);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.post("/social-accounts/finalize-selection", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { token, selectedIds } = req.body ?? {};
    if (typeof token !== "string" || !Array.isArray(selectedIds) || !selectedIds.every((id) => typeof id === "string")) {
      res.status(400).json({ error: "token and selectedIds (a non-empty array of strings) are required" });
      return;
    }
    try {
      const socialAccountIds = await finalizeConnectSelection(token, selectedIds, req.accountId, registry);
      res.json({ connected: true, socialAccountIds });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.get("/social-accounts", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("social_accounts")
      .select("id, platform, platform_account_id, display_name, connected_at, disconnected_at, brand_label, brand_id")
      .eq("account_id", req.accountId)
      .is("disconnected_at", null);
    if (error) {
      dbError(res, error, "GET /social-accounts");
      return;
    }
    res.json(data);
  });

  // Google Calendar two-way sync — a genuinely different shape from every
  // other connection above (not a platform to post TO, a two-way data
  // source), so it's deliberately its own small route group rather than
  // folded into /social-accounts/connect's platform-registry flow. See
  // googleCalendar/connect.ts's header comment for why.
  router.get("/google-calendar/status", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("google_calendar_connections")
      .select("google_calendar_id, connected_email, connected_at, last_synced_at")
      .eq("account_id", req.accountId)
      .is("disconnected_at", null)
      .maybeSingle();
    if (error) {
      dbError(res, error, "GET /google-calendar/status");
      return;
    }
    res.json({ connected: !!data, ...data });
  });

  router.get("/google-calendar/connect", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    if (!isGoogleCalendarConfigured()) {
      res.status(400).json({ error: "Google Calendar sync isn't available yet." });
      return;
    }
    try {
      const { url, stateId } = await startGoogleCalendarConnect(req.accountId!);
      // Same CSRF binding as /social-accounts/connect's lr_oauth_state
      // cookie — a distinct cookie name so the two connect flows can be in
      // flight at once without clobbering each other.
      res.cookie("lr_gcal_oauth_state", stateId, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 15 * 60_000,
      });
      res.json({ authorizeUrl: url });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/google-calendar/callback", publicRateLimit, async (req, res) => {
    const { code, state } = req.query;
    if (typeof code !== "string" || typeof state !== "string") {
      res.redirect(`${frontendUrl}/?gcalConnectError=${encodeURIComponent("Missing code or state")}`);
      return;
    }
    const cookieState = req.cookies?.lr_gcal_oauth_state;
    res.clearCookie("lr_gcal_oauth_state", { httpOnly: true, secure: true, sameSite: "none" });
    if (cookieState !== state) {
      res.redirect(
        `${frontendUrl}/?gcalConnectError=${encodeURIComponent("This connect link wasn't opened in the same browser it was started in — please try connecting again.")}`,
      );
      return;
    }
    try {
      await completeGoogleCalendarConnect(state, code);
      res.redirect(`${frontendUrl}/?gcalConnected=1`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.redirect(`${frontendUrl}/?gcalConnectError=${encodeURIComponent(message)}`);
    }
  });

  router.delete("/google-calendar", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    try {
      await disconnectGoogleCalendar(req.accountId!);
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Google's push notification endpoint (Phase 3, pushNotifications.ts) --
  // NOT behind requireAuth, same reasoning as /google-calendar/callback:
  // Google calls this directly with no way to attach our JWT. Identity
  // instead comes from X-Goog-Channel-Token, a random secret we generated
  // and stored per-connection at subscribe time, which Google echoes back
  // on every call for that channel. The notification itself carries no
  // data -- just "something changed" -- so a valid call just re-runs the
  // exact same syncConnectionInbound() the hourly poller already calls.
  router.post("/google-calendar/webhook", publicRateLimit, async (req, res) => {
    const channelId = req.header("X-Goog-Channel-ID");
    const receivedToken = req.header("X-Goog-Channel-Token");
    const resourceState = req.header("X-Goog-Resource-State");
    if (!channelId || !receivedToken) {
      res.status(404).end();
      return;
    }

    const { data: connection } = await supabase
      .from("google_calendar_connections")
      .select("id, account_id, google_calendar_id, sync_token, target_social_account_ids, watch_channel_token")
      .eq("watch_channel_id", channelId)
      .is("disconnected_at", null)
      .maybeSingle();

    const storedToken = connection?.watch_channel_token;
    // timingSafeEqual throws on mismatched buffer lengths rather than
    // returning false -- guard explicitly instead of catching, since an
    // unregistered/wrong channel id is an expected case, not an error.
    const tokenMatches =
      !!storedToken &&
      Buffer.byteLength(storedToken) === Buffer.byteLength(receivedToken) &&
      timingSafeEqual(Buffer.from(storedToken), Buffer.from(receivedToken));
    if (!connection || !tokenMatches) {
      res.status(404).end();
      return;
    }

    // Google's one-time handshake message when a channel starts -- nothing
    // to sync yet, just acknowledge it.
    if (resourceState === "sync") {
      res.status(200).end();
      return;
    }

    const row: GoogleCalendarConnectionRow = {
      id: connection.id,
      account_id: connection.account_id,
      google_calendar_id: connection.google_calendar_id,
      sync_token: connection.sync_token,
      target_social_account_ids: connection.target_social_account_ids,
    };
    await syncConnectionInbound(row);
    res.status(200).end();
  });

  // Multi-brand support. Started 2026-08-08 as a free-text label per account
  // (migration 0042); promoted 2026-08-16 to a real `brands` entity
  // (migration 0047) so brands can be COUNTED and CAPPED per tier — closing
  // the leak where unlimited brands let one login run an agency's worth of
  // client businesses for a flat fee. Still one login / one subscription, NOT
  // multi-tenant workspaces. Per-tier caps live in brandLimits.ts.
  //
  // Transition note: social_accounts.brand_label is KEPT as a denormalized
  // mirror of the assigned brand's name, so every existing filter (frontend
  // BrandFilterSelect + backend resolveBrandFilterSocialAccountIds, both of
  // which read brand_label) keeps working unchanged. brand_id is the capped
  // source of truth; brand_label is written in lockstep and dropped in a
  // later cleanup once filtering is migrated to brand_id.
  const MAX_BRAND_NAME_LENGTH = 60;
  // Free-text voice description ("casual, funny, short sentences, lots of
  // emoji") fed into the AI caption/hashtag prompts — generous but bounded,
  // same reasoning as MAX_POST_CONTENT_LENGTH elsewhere: a customer pasting
  // something enormous shouldn't blow out prompt size or cost unbounded.
  const MAX_VOICE_PROFILE_LENGTH = 2000;

  router.get("/brands", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("brands")
      .select("id, name, voice_profile, created_at")
      .eq("account_id", req.accountId)
      .order("name");
    if (error) {
      dbError(res, error, "GET /brands");
      return;
    }
    res.json(data);
  });

  router.post("/brands", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "Brand name is required" });
      return;
    }
    if (name.length > MAX_BRAND_NAME_LENGTH) {
      res.status(400).json({ error: `Brand name must be ${MAX_BRAND_NAME_LENGTH} characters or fewer` });
      return;
    }
    const { voiceProfile } = req.body ?? {};
    if (voiceProfile !== undefined && voiceProfile !== null && typeof voiceProfile !== "string") {
      res.status(400).json({ error: "voiceProfile must be a string or null" });
      return;
    }
    if (typeof voiceProfile === "string" && voiceProfile.length > MAX_VOICE_PROFILE_LENGTH) {
      res.status(400).json({ error: `voiceProfile must be ${MAX_VOICE_PROFILE_LENGTH} characters or fewer` });
      return;
    }
    // Real per-tier cap, not just marketing copy — see brandLimits.ts.
    const limitError = await checkBrandLimit(req.accountId!);
    if (limitError) {
      res.status(403).json({ error: limitError });
      return;
    }
    const { data, error } = await supabase
      .from("brands")
      .insert({ account_id: req.accountId, name, voice_profile: voiceProfile?.trim() || null })
      .select("id, name, voice_profile, created_at")
      .maybeSingle();
    if (error) {
      // 23505 = the case-insensitive unique index on (account_id, lower(name)).
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({ error: "You already have a brand with that name." });
        return;
      }
      dbError(res, error, "POST /brands");
      return;
    }
    res.status(201).json(data);
  });

  router.patch("/brands/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "Brand name is required" });
      return;
    }
    if (name.length > MAX_BRAND_NAME_LENGTH) {
      res.status(400).json({ error: `Brand name must be ${MAX_BRAND_NAME_LENGTH} characters or fewer` });
      return;
    }
    const { voiceProfile } = req.body ?? {};
    if (voiceProfile !== undefined && voiceProfile !== null && typeof voiceProfile !== "string") {
      res.status(400).json({ error: "voiceProfile must be a string or null" });
      return;
    }
    if (typeof voiceProfile === "string" && voiceProfile.length > MAX_VOICE_PROFILE_LENGTH) {
      res.status(400).json({ error: `voiceProfile must be ${MAX_VOICE_PROFILE_LENGTH} characters or fewer` });
      return;
    }
    const update: Record<string, unknown> = { name };
    if (voiceProfile !== undefined) update.voice_profile = voiceProfile?.trim() || null;
    const { data, error } = await supabase
      .from("brands")
      .update(update)
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .select("id, name, voice_profile, created_at")
      .maybeSingle();
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({ error: "You already have a brand with that name." });
        return;
      }
      dbError(res, error, "PATCH /brands/:id");
      return;
    }
    if (!data) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    // Keep the brand_label mirror in sync on this brand's accounts.
    const { error: mirrorError } = await supabase
      .from("social_accounts")
      .update({ brand_label: name })
      .eq("account_id", req.accountId)
      .eq("brand_id", req.params.id);
    if (mirrorError) {
      dbError(res, mirrorError, "PATCH /brands/:id mirror");
      return;
    }
    res.json(data);
  });

  router.delete("/brands/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    // Clear the brand_label mirror on this brand's accounts first. brand_id
    // auto-nulls via the FK's `on delete set null`, but the denormalized
    // mirror must be cleared explicitly.
    const { error: mirrorError } = await supabase
      .from("social_accounts")
      .update({ brand_label: null })
      .eq("account_id", req.accountId)
      .eq("brand_id", req.params.id);
    if (mirrorError) {
      dbError(res, mirrorError, "DELETE /brands/:id mirror");
      return;
    }
    const { data, error } = await supabase
      .from("brands")
      .delete()
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .select("id")
      .maybeSingle();
    if (error) {
      dbError(res, error, "DELETE /brands/:id");
      return;
    }
    if (!data) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    res.status(204).end();
  });

  // Assign (or clear) a connected account's brand. brandId must reference a
  // brand owned by this caller, or be null to unbrand. Also writes the
  // brand_label mirror (see the transition note above).
  router.patch("/social-accounts/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { brandId } = req.body ?? {};
    if (brandId !== undefined && brandId !== null && typeof brandId !== "string") {
      res.status(400).json({ error: "brandId must be a string or null" });
      return;
    }
    let brandName: string | null = null;
    if (brandId) {
      const { data: brand, error: brandError } = await supabase
        .from("brands")
        .select("id, name")
        .eq("id", brandId)
        .eq("account_id", req.accountId)
        .maybeSingle();
      if (brandError) {
        dbError(res, brandError, "PATCH /social-accounts/:id brand lookup");
        return;
      }
      if (!brand) {
        res.status(404).json({ error: "Brand not found or not owned by this caller" });
        return;
      }
      brandName = brand.name;
    }
    const { data, error } = await supabase
      .from("social_accounts")
      .update({ brand_id: brandId ?? null, brand_label: brandName })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .select("id, platform, platform_account_id, display_name, connected_at, disconnected_at, brand_label, brand_id")
      .maybeSingle();
    if (error) {
      dbError(res, error, "PATCH /social-accounts/:id");
      return;
    }
    if (!data) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
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
  // Alt text (2026-08-16) — an optional accessibility description attached
  // to the file itself, independent of which post(s) it ends up in.
  const MAX_ALT_TEXT_LENGTH = 1000; // matches Mastodon's own limit, the one adapter that consumes it today
  router.post("/media/upload", requireAuth, tieredRateLimit, upload.single("file"), async (req: AuthedRequest, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded (expected multipart field \"file\")" });
      return;
    }
    // multer puts non-file multipart fields onto req.body as strings.
    const altTextInput = req.body?.altText;
    if (altTextInput !== undefined && typeof altTextInput !== "string") {
      res.status(400).json({ error: "altText must be a string" });
      return;
    }
    if (typeof altTextInput === "string" && altTextInput.length > MAX_ALT_TEXT_LENGTH) {
      res.status(400).json({ error: `altText must be ${MAX_ALT_TEXT_LENGTH} characters or fewer` });
      return;
    }
    const altText = altTextInput?.trim() || null;
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

    const { data: mediaRow, error: metaError } = await supabase
      .from("media_uploads")
      .insert({
        account_id: req.accountId,
        url: data.publicUrl,
        storage_path: path,
        mime_type: detected.mime,
        size_bytes: file.buffer.length,
        width,
        height,
        alt_text: altText,
      })
      .select("id, url, alt_text")
      .single();
    if (metaError) {
      dbError(res, metaError, "POST /media/upload media_uploads.insert");
      return;
    }

    // id included alongside the historical `url`-only shape so a caller can
    // later PATCH /media/:id to add/edit alt text without a separate lookup.
    res.status(201).json({ id: mediaRow.id, url: mediaRow.url, altText: mediaRow.alt_text });
  });

  // Edits a media item's alt text after upload (2026-08-16) — the one field
  // on media_uploads a customer can revise later; everything else about an
  // uploaded file is immutable (re-upload to change the file itself).
  router.patch("/media/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const altTextInput = req.body?.altText;
    if (altTextInput !== undefined && altTextInput !== null && typeof altTextInput !== "string") {
      res.status(400).json({ error: "altText must be a string or null" });
      return;
    }
    if (typeof altTextInput === "string" && altTextInput.length > MAX_ALT_TEXT_LENGTH) {
      res.status(400).json({ error: `altText must be ${MAX_ALT_TEXT_LENGTH} characters or fewer` });
      return;
    }
    const { data: updated, error } = await supabase
      .from("media_uploads")
      .update({ alt_text: altTextInput?.trim() || null })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .select("id, url, alt_text")
      .maybeSingle();
    if (error) {
      dbError(res, error, "PATCH /media/:id");
      return;
    }
    if (!updated) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    res.json({ id: updated.id, url: updated.url, altText: updated.alt_text });
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
  // near quota. Each file also carries `platforms`: which platform(s) it's
  // actually been posted to, so the frontend can group storage by platform
  // (2026-08-20). A file isn't tied to a platform at upload time and the
  // same file can be posted to several platforms at once, so this is a
  // many-to-many map, not a single owner — built from the account's FULL
  // post history (not just the recent slice /scheduled-posts keeps in
  // memory for the dashboard) so the breakdown stays accurate for accounts
  // with a long posting history.
  router.get("/media", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const [
      { data: media, error },
      { data: postRows, error: postsError },
      { data: scheduleRows, error: scheduleError },
    ] = await Promise.all([
      supabase
        .from("media_uploads")
        .select("id, url, mime_type, size_bytes, width, height, alt_text, created_at")
        .eq("account_id", req.accountId)
        .order("created_at", { ascending: false }),
      supabase
        .from("scheduled_posts")
        .select("media_url, social_accounts(platform)")
        .eq("account_id", req.accountId)
        .not("media_url", "is", null),
      supabase
        .from("recurring_schedule_targets")
        .select("social_accounts(platform), recurring_schedules!inner(media_url, account_id)")
        .eq("recurring_schedules.account_id", req.accountId),
    ]);
    if (error) {
      dbError(res, error, "GET /media");
      return;
    }
    if (postsError) {
      dbError(res, postsError, "GET /media scheduled_posts lookup");
      return;
    }
    if (scheduleError) {
      dbError(res, scheduleError, "GET /media recurring_schedule_targets lookup");
      return;
    }

    // Supabase's embed comes back as an object or a single-element array
    // depending on how it infers the relationship's cardinality — normalize
    // both shapes rather than assuming one (same defensive pattern used for
    // social_accounts(platform) elsewhere in this file).
    function embedOne<T>(x: T | T[] | null | undefined): T | null {
      return Array.isArray(x) ? (x[0] ?? null) : (x ?? null);
    }

    const platformsByUrl = new Map<string, Set<string>>();
    function addUsage(url: string | null | undefined, platform: string | null | undefined) {
      if (!url || !platform) return;
      const set = platformsByUrl.get(url) ?? new Set<string>();
      set.add(platform);
      platformsByUrl.set(url, set);
    }
    for (const row of postRows ?? []) {
      addUsage(row.media_url, embedOne(row.social_accounts as { platform: string } | { platform: string }[] | null)?.platform);
    }
    for (const row of scheduleRows ?? []) {
      const schedule = embedOne(row.recurring_schedules as { media_url: string | null } | { media_url: string | null }[] | null);
      addUsage(schedule?.media_url, embedOne(row.social_accounts as { platform: string } | { platform: string }[] | null)?.platform);
    }

    res.json(
      (media ?? []).map((m) => ({
        ...m,
        platforms: [...(platformsByUrl.get(m.url) ?? new Set<string>())].sort(),
      })),
    );
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

  // Drafts (2026-08-16) — a scheduled_posts row with no committed account or
  // time yet (both nullable as of migration 0049), invisible to the
  // scheduler (claimDuePosts only ever selects status='pending'). Content is
  // the only required field; media/cover/board/first-comment are all
  // optional, same fields a real post accepts, just none of the
  // account/timing validation validatePostFields does — there's nothing to
  // validate against yet.
  router.post("/scheduled-posts/draft", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { content, mediaUrl, coverImageUrl, boardId, destinationLink, firstComment, mediaAltText, plannedDate, plannedAccountIds, scheduledFor } = req.body ?? {};
    if (typeof content !== "string" || content.trim().length === 0) {
      res.status(400).json({ error: "content must be a non-empty string" });
      return;
    }
    if (content.length > MAX_POST_CONTENT_LENGTH) {
      res.status(400).json({ error: `content must be ${MAX_POST_CONTENT_LENGTH} characters or fewer` });
      return;
    }
    for (const [name, value] of [["coverImageUrl", coverImageUrl], ["boardId", boardId], ["destinationLink", destinationLink], ["firstComment", firstComment], ["mediaAltText", mediaAltText]] as const) {
      if (value !== undefined && value !== null && typeof value !== "string") {
        res.status(400).json({ error: `${name} must be a string` });
        return;
      }
    }
    if (plannedDate !== undefined && plannedDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(plannedDate)) {
      res.status(400).json({ error: "plannedDate must be a YYYY-MM-DD string" });
      return;
    }
    if (scheduledFor !== undefined && scheduledFor !== null) {
      if (typeof scheduledFor !== "string" || Number.isNaN(new Date(scheduledFor).getTime())) {
        res.status(400).json({ error: "scheduledFor must be a valid ISO date string" });
        return;
      }
    }
    // Pre-selected platform(s) for this plan item (2026-08-20) — advisory
    // only while status stays 'draft'; ownership is verified here so a
    // customer can't stash an id they don't own, but the real safety check
    // that matters (can this actually be posted) happens again at
    // promotion time via the existing /schedule and POST routes, same as
    // any other post.
    let validatedPlannedAccountIds: string[] | null = null;
    if (plannedAccountIds !== undefined && plannedAccountIds !== null) {
      if (!Array.isArray(plannedAccountIds) || plannedAccountIds.some((id) => typeof id !== "string")) {
        res.status(400).json({ error: "plannedAccountIds must be an array of strings" });
        return;
      }
      if (plannedAccountIds.length > 0) {
        const { data: owned, error: ownedError } = await supabase
          .from("social_accounts")
          .select("id")
          .in("id", plannedAccountIds)
          .eq("account_id", req.accountId);
        if (ownedError) {
          dbError(res, ownedError, "POST /scheduled-posts/draft (plannedAccountIds ownership)");
          return;
        }
        if ((owned ?? []).length !== new Set(plannedAccountIds).size) {
          res.status(403).json({ error: "One or more plannedAccountIds are not owned by this caller" });
          return;
        }
      }
      validatedPlannedAccountIds = plannedAccountIds.length > 0 ? plannedAccountIds : null;
    }
    const { data, error } = await supabase
      .from("scheduled_posts")
      .insert({
        account_id: req.accountId,
        social_account_id: null,
        content,
        media_url: mediaUrl ?? null,
        cover_image_url: coverImageUrl ?? null,
        board_id: boardId ?? null,
        destination_link: destinationLink ?? null,
        first_comment: firstComment ?? null,
        media_alt_text: mediaAltText ?? null,
        planned_date: plannedDate ?? null,
        planned_account_ids: validatedPlannedAccountIds,
        scheduled_for: scheduledFor ?? null,
        status: "draft",
      })
      .select()
      .single();
    if (error) {
      dbError(res, error, "POST /scheduled-posts/draft");
      return;
    }
    res.status(201).json(data);
  });

  // Edits a draft in place — only while it's still a draft (status check
  // below). Editing a live pending post's content isn't supported anywhere
  // in this app today (the existing pattern for that is delete + recreate);
  // this route deliberately doesn't change that, it only ever touches rows
  // that are still status='draft'.
  router.patch("/scheduled-posts/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: existing, error: fetchError } = await supabase
      .from("scheduled_posts")
      .select("id, status")
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (fetchError) {
      dbError(res, fetchError, "PATCH /scheduled-posts/:id lookup");
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    if (existing.status !== "draft") {
      res.status(409).json({ error: "Only drafts can be edited this way — use /schedule to turn a draft into a real scheduled post." });
      return;
    }

    const { content, mediaUrl, coverImageUrl, boardId, destinationLink, firstComment, mediaAltText, plannedDate } = req.body ?? {};
    const update: Record<string, unknown> = {};
    if (content !== undefined) {
      if (typeof content !== "string" || content.trim().length === 0) {
        res.status(400).json({ error: "content must be a non-empty string" });
        return;
      }
      if (content.length > MAX_POST_CONTENT_LENGTH) {
        res.status(400).json({ error: `content must be ${MAX_POST_CONTENT_LENGTH} characters or fewer` });
        return;
      }
      update.content = content;
    }
    for (const [key, name, value] of [
      ["media_url", "mediaUrl", mediaUrl],
      ["cover_image_url", "coverImageUrl", coverImageUrl],
      ["board_id", "boardId", boardId],
      ["destination_link", "destinationLink", destinationLink],
      ["first_comment", "firstComment", firstComment],
      ["media_alt_text", "mediaAltText", mediaAltText],
    ] as const) {
      if (value !== undefined) {
        if (value !== null && typeof value !== "string") {
          res.status(400).json({ error: `${name} must be a string` });
          return;
        }
        update[key] = value;
      }
    }
    if (plannedDate !== undefined) {
      if (plannedDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(plannedDate)) {
        res.status(400).json({ error: "plannedDate must be a YYYY-MM-DD string" });
        return;
      }
      update.planned_date = plannedDate;
    }

    const { data, error } = await supabase
      .from("scheduled_posts")
      .update(update)
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .select()
      .single();
    if (error) {
      dbError(res, error, "PATCH /scheduled-posts/:id");
      return;
    }
    void syncPostToCalendar(data.id);
    res.json(data);
  });

  // Promotes a draft into a real scheduled post — the same
  // socialAccountId/scheduledFor (and the same validation) a fresh
  // POST /scheduled-posts would need, applied to the existing draft row via
  // UPDATE instead of a new INSERT. Reuses validatePostFields and
  // checkFreeTierPostLimit so a promoted draft counts against the free-tier
  // monthly cap exactly like a brand-new post — it's the same real post,
  // just created a bit earlier.
  router.patch("/scheduled-posts/:id/schedule", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: existing, error: fetchError } = await supabase
      .from("scheduled_posts")
      .select("id, status")
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (fetchError) {
      dbError(res, fetchError, "PATCH /scheduled-posts/:id/schedule lookup");
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    if (existing.status !== "draft") {
      res.status(409).json({ error: "This post has already been scheduled." });
      return;
    }

    const validated = await validatePostFields(req.accountId, req.body ?? {});
    if ("status" in validated) {
      res.status(validated.status).json(validated.body);
      return;
    }
    const { socialAccountId, content, mediaUrl, coverImageUrl, boardId, destinationLink, firstComment, mediaAltText, scheduledFor } = validated;

    const limitError = await checkFreeTierPostLimit(req.accountId, socialAccountId);
    if (limitError) {
      res.status(limitError.status).json(limitError.body);
      return;
    }

    const { data, error } = await supabase
      .from("scheduled_posts")
      .update({
        social_account_id: socialAccountId,
        content,
        media_url: mediaUrl,
        cover_image_url: coverImageUrl,
        board_id: boardId,
        destination_link: destinationLink,
        first_comment: firstComment,
        media_alt_text: mediaAltText,
        scheduled_for: scheduledFor,
        status: req.body?.requiresApproval === true ? "needs_approval" : "pending",
      })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .select()
      .single();
    if (error) {
      dbError(res, error, "PATCH /scheduled-posts/:id/schedule");
      return;
    }
    void syncPostToCalendar(data.id);
    res.json(data);
  });

  const HISTORY_STATUSES = ["posted", "failed"];
  const SCHEDULED_POSTS_HISTORY_DEFAULT_LIMIT = 50;
  const SCHEDULED_POSTS_HISTORY_MAX_LIMIT = 100;

  // Bounded on purpose: this used to fetch a customer's ENTIRE post
  // history on every dashboard load, with the frontend only ever slicing
  // an already-fully-loaded array for "Load more" — a customer posting a
  // handful of times a day accumulates hundreds of rows within weeks, and
  // every page load kept getting slower forever. "Upcoming" posts
  // (pending/posting/needs_approval, and — 2026-08-16 — draft) are
  // naturally small — they only exist until they fire (or, for a draft,
  // until scheduled/deleted) — so those are always returned in full. History
  // (posted/failed) is capped here to the most recent
  // SCHEDULED_POSTS_HISTORY_DEFAULT_LIMIT; anything older is fetched a
  // page at a time via GET /scheduled-posts/history. Drafts have
  // scheduled_for = null, which Postgres sorts last in ascending order —
  // they naturally land at the end of the upcoming list, after every real
  // scheduled post.
  router.get("/scheduled-posts", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const [{ data: upcoming, error: upcomingError }, { data: history, error: historyError }] = await Promise.all([
      supabase
        .from("scheduled_posts")
        .select("*, post_results(*)")
        .eq("account_id", req.accountId)
        .in("status", ["pending", "posting", "needs_approval", "draft"])
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
  // Reads from mention_comments_cache (kept fresh by
  // mentionsAndDmsPoller.ts) rather than calling each platform live — see
  // migration 0058_mentions_dms_cache.sql. Post-level metadata
  // (content/scheduledFor/platformPostUrl) still comes straight from
  // scheduled_posts/post_results since the cache only stores comments.
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

    const postIds = (posts ?? []).map((p) => p.id);
    const { data: cachedComments, error: cacheError } = postIds.length
      ? await supabase
          .from("mention_comments_cache")
          .select("scheduled_post_id, platform_comment_id, author, text, url, comment_created_at")
          .in("scheduled_post_id", postIds)
          .order("comment_created_at", { ascending: true })
      : { data: [] as never[], error: null };
    if (cacheError) {
      dbError(res, cacheError, "GET /mentions cache lookup");
      return;
    }
    const commentsByPost = new Map<string, (CommentItem & { triage?: TriageResult | null })[]>();
    for (const c of cachedComments ?? []) {
      const list = commentsByPost.get(c.scheduled_post_id) ?? [];
      list.push({ id: c.platform_comment_id, author: c.author, text: c.text, url: c.url, createdAt: c.comment_created_at });
      commentsByPost.set(c.scheduled_post_id, list);
    }

    const results: {
      postId: string;
      socialAccountId: string;
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
      const comments = commentsByPost.get(post.id) ?? [];
      results.push({
        postId: post.id,
        socialAccountId: post.social_account_id,
        platform,
        content: post.content,
        scheduledFor: post.scheduled_for,
        platformPostUrl: result.platform_post_url,
        supported: !!adapter?.getComments,
        canReply: !!adapter?.replyToComment,
        comments,
      });
      commentTriageItems.push(...comments.map((c) => ({ itemId: c.id, sourceSignature: c.id, author: c.author, text: c.text })));
    }

    // One batched Anthropic call for every not-yet-cached comment across
    // every post shown here, rather than one call per post — see
    // commentTriage.ts. Missing from the map means unclassified (no API
    // key configured, or the AI call failed), never treated as "routine".
    // In practice this is nearly always a cache hit now, since the poller
    // already ran triageItems() over these same comments when it cached
    // them.
    const triageMap = await triageItems(req.accountId!, "comment", commentTriageItems);
    for (const post of results) {
      post.comments = post.comments.map((c) => ({ ...c, triage: triageMap.get(c.id) ?? null }));
    }

    // Marks these as viewed AFTER the read that produced them, same
    // ordering dmAutomationPoller uses for its own side effects — a
    // comment that lands between this read and the next poll simply shows
    // up as new next time, not lost.
    await supabase
      .from("notification_view_state")
      .upsert({ account_id: req.accountId, mentions_last_viewed_at: new Date().toISOString() }, { onConflict: "account_id" });

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
  // Reads from dm_conversations_cache (kept fresh by
  // mentionsAndDmsPoller.ts) rather than calling each connected account's
  // platform live — see migration 0058_mentions_dms_cache.sql.
  router.get("/dms", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: accounts, error } = await supabase
      .from("social_accounts")
      .select("id, platform, display_name")
      .eq("account_id", req.accountId)
      .is("disconnected_at", null);
    if (error) {
      dbError(res, error, "GET /dms");
      return;
    }
    const accountById = new Map((accounts ?? []).map((a) => [a.id, a]));
    const socialAccountIds = (accounts ?? []).map((a) => a.id);

    const { data: cached, error: cacheError } = socialAccountIds.length
      ? await supabase
          .from("dm_conversations_cache")
          .select("social_account_id, conversation_id, participant_id, participant_name, snippet, conversation_updated_at")
          .in("social_account_id", socialAccountIds)
      : { data: [] as never[], error: null };
    if (cacheError) {
      dbError(res, cacheError, "GET /dms cache lookup");
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
    for (const c of cached ?? []) {
      const account = accountById.get(c.social_account_id);
      if (!account) continue; // stale row for a since-disconnected account
      results.push({
        socialAccountId: c.social_account_id,
        platform: account.platform,
        accountDisplayName: account.display_name,
        conversationId: c.conversation_id,
        participantId: c.participant_id,
        participantName: c.participant_name,
        snippet: c.snippet,
        updatedAt: c.conversation_updated_at,
      });
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

    await supabase
      .from("notification_view_state")
      .upsert({ account_id: req.accountId, dms_last_viewed_at: new Date().toISOString() }, { onConflict: "account_id" });

    res.json({ conversations: results });
  });

  // Powers the dashboard's notification bell — a cheap read of the two
  // cache tables (see migration 0058_mentions_dms_cache.sql), never a live
  // platform call. "New" means discovered/updated after the customer last
  // actually loaded that tab (notification_view_state, bumped by GET
  // /mentions and GET /dms themselves). Falls back to first_seen_at when a
  // platform doesn't supply its own timestamp (comment_created_at /
  // conversation_updated_at can both be null).
  router.get("/notifications/summary", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: viewState, error: viewStateError } = await supabase
      .from("notification_view_state")
      .select("mentions_last_viewed_at, dms_last_viewed_at")
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (viewStateError) {
      dbError(res, viewStateError, "GET /notifications/summary view state");
      return;
    }
    const mentionsSinceMs = new Date(viewState?.mentions_last_viewed_at ?? "1970-01-01T00:00:00Z").getTime();
    const dmsSinceMs = new Date(viewState?.dms_last_viewed_at ?? "1970-01-01T00:00:00Z").getTime();

    const [{ data: mentionRows, error: mentionsError }, { data: dmRows, error: dmsError }] = await Promise.all([
      supabase.from("mention_comments_cache").select("comment_created_at, first_seen_at").eq("account_id", req.accountId),
      supabase.from("dm_conversations_cache").select("conversation_updated_at, first_seen_at").eq("account_id", req.accountId),
    ]);
    if (mentionsError) {
      dbError(res, mentionsError, "GET /notifications/summary mentions");
      return;
    }
    if (dmsError) {
      dbError(res, dmsError, "GET /notifications/summary dms");
      return;
    }

    const newMentions = (mentionRows ?? []).filter(
      (r) => new Date(r.comment_created_at ?? r.first_seen_at).getTime() > mentionsSinceMs,
    ).length;
    const newDms = (dmRows ?? []).filter(
      (r) => new Date(r.conversation_updated_at ?? r.first_seen_at).getTime() > dmsSinceMs,
    ).length;

    res.json({ newMentions, newDms });
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
  // Multi-brand filtering (2026-08-08, item 8) — this route pre-aggregates
  // server-side (unlike Posts/Mentions/DMs, which send raw rows the
  // frontend can filter by social_account_id itself), so brand filtering
  // has to happen here rather than client-side. "brand" query param:
  // omitted = no filter, "__unbranded__" = accounts with no brand_label,
  // anything else = that exact label.
  const UNBRANDED_FILTER_VALUE = "__unbranded__";

  // Shared by /analytics/summary and /analytics/insight — both need to
  // resolve a "brand" filter value down to the matching social_account_ids
  // before querying scheduled_posts. Returns undefined for "no filter".
  async function resolveBrandFilterSocialAccountIds(accountId: string, brand: string | undefined): Promise<string[] | undefined> {
    if (brand === undefined) return undefined;
    let query = supabase.from("social_accounts").select("id").eq("account_id", accountId);
    query = brand === UNBRANDED_FILTER_VALUE ? query.is("brand_label", null) : query.eq("brand_label", brand);
    const { data, error } = await query;
    if (error) throw error;
    // A dummy UUID when nothing matches, rather than an empty array — .in()
    // with an empty list isn't a reliable "match nothing" across Supabase
    // JS versions, and this guarantees zero rows either way.
    return data && data.length > 0 ? data.map((r) => r.id) : ["00000000-0000-0000-0000-000000000000"];
  }

  router.get("/analytics/summary", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const brand = typeof req.query.brand === "string" && req.query.brand.length > 0 ? req.query.brand : undefined;

    let matchingSocialAccountIds: string[] | undefined;
    try {
      matchingSocialAccountIds = await resolveBrandFilterSocialAccountIds(req.accountId!, brand);
    } catch (err) {
      dbError(res, err as { message: string }, "GET /analytics/summary (brand filter)");
      return;
    }

    let scheduledPostsQuery = supabase
      .from("scheduled_posts")
      .select(
        "id, status, scheduled_for, social_accounts(platform), post_results(verified_live, error_message), post_metrics(checkpoint, likes, comments, shares, views)"
      )
      .eq("account_id", req.accountId)
      .gte("scheduled_for", since)
      .order("scheduled_for", { ascending: true });
    if (matchingSocialAccountIds) {
      scheduledPostsQuery = scheduledPostsQuery.in("social_account_id", matchingSocialAccountIds);
    }
    // Audience growth (2026-08-17) — same brand-filter scoping as the posts
    // query above, just against audience_snapshots instead of
    // scheduled_posts. social_accounts(platform) joined in so the frontend
    // can group by platform without a second round trip.
    let audienceSnapshotsQuery = supabase
      .from("audience_snapshots")
      .select("social_account_id, follower_count, snapshot_date, social_accounts(platform)")
      .eq("account_id", req.accountId)
      .gte("snapshot_date", since.slice(0, 10))
      .order("snapshot_date", { ascending: true });
    if (matchingSocialAccountIds) {
      audienceSnapshotsQuery = audienceSnapshotsQuery.in("social_account_id", matchingSocialAccountIds);
    }

    const [
      { data, error },
      { data: dmAutomationRows },
      { count: accountsConnectedCount },
      { data: audienceSnapshotRows, error: audienceError },
    ] = await Promise.all([
      scheduledPostsQuery,
      supabase.from("dm_automations").select("id").eq("account_id", req.accountId),
      supabase.from("social_accounts").select("id", { count: "exact", head: true }).eq("account_id", req.accountId).is("disconnected_at", null),
      audienceSnapshotsQuery,
    ]);
    if (error) {
      dbError(res, error, "GET /analytics/summary");
      return;
    }
    if (audienceError) {
      dbError(res, audienceError, "GET /analytics/summary (audience growth)");
      return;
    }
    const automationIds = (dmAutomationRows ?? []).map((a: { id: string }) => a.id);

    // Per platform: the trend as [{date, followerCount}] (summed across every
    // connected account on that platform, in case there's more than one),
    // plus the simple net change over the whole range so the UI doesn't have
    // to recompute it. A platform absent from this map means no connected
    // account there supports follower-count reads yet (see
    // PlatformAdapter.getFollowerCount) — honestly absent, not a silent zero.
    const audienceGrowth: Record<string, { trend: { date: string; followerCount: number }[]; netChange: number | null }> = {};
    {
      const byPlatformAndDate: Record<string, Record<string, number>> = {};
      for (const row of audienceSnapshotRows ?? []) {
        const platform = Array.isArray(row.social_accounts)
          ? (row.social_accounts[0] as { platform?: string } | undefined)?.platform
          : (row.social_accounts as { platform?: string } | null)?.platform;
        const platformKey = platform ?? "unknown";
        byPlatformAndDate[platformKey] ??= {};
        byPlatformAndDate[platformKey][row.snapshot_date] =
          (byPlatformAndDate[platformKey][row.snapshot_date] ?? 0) + row.follower_count;
      }
      for (const [platformKey, byDate] of Object.entries(byPlatformAndDate)) {
        const trend = Object.entries(byDate)
          .map(([date, followerCount]) => ({ date, followerCount }))
          .sort((a, b) => a.date.localeCompare(b.date));
        const netChange = trend.length >= 2 ? trend[trend.length - 1].followerCount - trend[0].followerCount : null;
        audienceGrowth[platformKey] = { trend, netChange };
      }
    }
    let dmCount = 0;
    if (automationIds.length > 0) {
      const { count } = await supabase
        .from("dm_automation_log")
        .select("automation_id", { count: "exact", head: true })
        .in("automation_id", automationIds);
      dmCount = count ?? 0;
    }
    const accountsConnected = accountsConnectedCount ?? 0;

    const byStatus: Record<string, number> = {};
    const byPlatform: Record<string, { total: number; posted: number; failed: number; verifiedLive: number }> = {};
    const dailyCounts: Record<string, number> = {};
    // Per-platform breakdown of the same daily counts above (2026-08-20) —
    // additive, same loop, same `day`/`platformKey` already computed below,
    // so this costs nothing extra to accumulate.
    const dailyCountsByPlatform: Record<string, Record<string, number>> = {};
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
      dailyCountsByPlatform[platformKey] ??= {};
      dailyCountsByPlatform[platformKey][day] = (dailyCountsByPlatform[platformKey][day] ?? 0) + 1;

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
      dailyCountsByPlatform,
      verifiedLiveRate: postedCount > 0 ? verifiedLiveCount / postedCount : null,
      engagement,
      dmCount,
      accountsConnected,
      audienceGrowth,
    });
  });

  // "Why this worked" AI insight (2026-08-08) — item 9 from the 2026-08-07
  // competitor audit's "my own ideas" list, explicitly scoped to depend on
  // real engagement analytics (item 1, shipped 2026-08-07). On-demand only
  // (a button on the Analytics tab, not automatic per post) — running this
  // on every post would be both expensive and mostly noise on posts too
  // fresh to have real engagement data yet. Compares the best- and
  // worst-performing posts in the customer's selected range/brand rather
  // than reasoning over raw totals, since a pattern only shows up in
  // contrast, not in a single aggregate number.
  const MIN_POSTS_WITH_DATA_FOR_INSIGHT = 4;
  router.post("/analytics/insight", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "AI insight isn't set up on this deploy yet." });
      return;
    }

    const { days, brand } = req.body ?? {};
    const rangeDays = Math.min(Math.max(Number(days) || 30, 1), 90);
    const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();
    const brandFilterValue = typeof brand === "string" && brand.length > 0 ? brand : undefined;

    let matchingSocialAccountIds: string[] | undefined;
    try {
      matchingSocialAccountIds = await resolveBrandFilterSocialAccountIds(req.accountId!, brandFilterValue);
    } catch (err) {
      dbError(res, err as { message: string }, "POST /analytics/insight (brand filter)");
      return;
    }

    const limitReason = await checkGenerationLimit(req.accountId!);
    if (limitReason) {
      res.status(429).json({ error: limitReason });
      return;
    }

    let postsQuery = supabase
      .from("scheduled_posts")
      .select("id, content, post_metrics(checkpoint, likes, comments, shares, views)")
      .eq("account_id", req.accountId)
      .eq("status", "posted")
      .gte("scheduled_for", since);
    if (matchingSocialAccountIds) {
      postsQuery = postsQuery.in("social_account_id", matchingSocialAccountIds);
    }
    const { data: posts, error } = await postsQuery;
    if (error) {
      dbError(res, error, "POST /analytics/insight");
      return;
    }

    // Same "most mature checkpoint wins" reduction as /analytics/summary's
    // engagement aggregation — a post's current number, not a sum across
    // every checkpoint it's ever had.
    const CHECKPOINT_MATURITY = ["30d", "7d", "3d", "24h", "6h", "1h"];
    type MetricRow = { checkpoint: string; likes: number | null; comments: number | null; shares: number | null; views: number | null };
    const scored: { content: string; likes: number; comments: number; shares: number; score: number }[] = [];
    for (const post of posts ?? []) {
      const metricRows: MetricRow[] = Array.isArray(post.post_metrics) ? post.post_metrics : post.post_metrics ? [post.post_metrics] : [];
      if (metricRows.length === 0) continue;
      const best = metricRows.reduce((a, b) => (CHECKPOINT_MATURITY.indexOf(a.checkpoint) <= CHECKPOINT_MATURITY.indexOf(b.checkpoint) ? a : b));
      const likes = best.likes ?? 0;
      const comments = best.comments ?? 0;
      const shares = best.shares ?? 0;
      // Weighted toward the more deliberate engagement types — a share
      // signals more than a like, a comment more than neither.
      scored.push({ content: post.content, likes, comments, shares, score: likes + comments * 2 + shares * 3 });
    }

    if (scored.length < MIN_POSTS_WITH_DATA_FOR_INSIGHT) {
      res.json({ insufficientData: true, postsWithData: scored.length, needed: MIN_POSTS_WITH_DATA_FOR_INSIGHT });
      return;
    }

    scored.sort((a, b) => b.score - a.score);
    const half = Math.max(1, Math.min(3, Math.floor(scored.length / 2)));
    const top = scored.slice(0, half);
    const bottom = scored.slice(-half);
    const describePost = (p: (typeof scored)[number]) => `"${p.content.slice(0, 200)}" (${p.likes} likes, ${p.comments} comments, ${p.shares} shares)`;

    try {
      // Same timeout reasoning as the other Anthropic-backed routes above.
      const client = new Anthropic({ apiKey, timeout: 20_000 });
      const message = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content:
              `You're analyzing a small business's social media performance. Here are their best-performing posts:\n\n` +
              `${top.map(describePost).join("\n")}\n\n` +
              `And their worst-performing posts:\n\n${bottom.map(describePost).join("\n")}\n\n` +
              `In 2-3 short sentences, say what pattern seems to separate the better posts from the worse ones (tone, ` +
              `format, topic, length, whatever's actually visible in the text), then give one concrete, specific suggestion ` +
              `for their next post. Be honest if the sample is too mixed to draw a clean conclusion, don't force a pattern that isn't there. ` +
              `Output ONLY the insight text, no preamble, no headers.`,
          },
        ],
      });
      const textBlock = message.content.find((block) => block.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        res.status(502).json({ error: "AI insight returned no usable text." });
        return;
      }
      await recordGeneration(req.accountId!);
      res.json({ insight: textBlock.text.trim() });
    } catch (err) {
      console.error("[routes] POST /analytics/insight:", err instanceof Error ? err.message : err);
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        res.status(504).json({ error: "AI insight took too long, please try again." });
        return;
      }
      res.status(502).json({ error: "AI insight failed, please try again." });
    }
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
    // 2026-08-30 fix: every other route that changes a post's calendar-
    // relevant state (create, reschedule, delete) calls syncPostToCalendar —
    // this one never did, so an approved post silently never appeared on
    // the customer's Google Calendar even though it's now really scheduled.
    void syncPostToCalendar(data.id);
    res.json(data);
  });

  // Move an already-pending post to a new day/time — including "post now"
  // (frontend just passes the current time), since claimDuePosts() already
  // polls for status='pending' AND scheduled_for<=now() and
  // validatePostFields already treats "now" as legitimate. There was no way
  // to do this at all before 2026-08-30 — the only previous option was
  // delete + recreate (see the comment on PATCH /scheduled-posts/:id above).
  router.patch("/scheduled-posts/:id/reschedule", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const scheduledForCheck = validateScheduledFor((req.body ?? {}).scheduledFor);
    if ("status" in scheduledForCheck) {
      res.status(scheduledForCheck.status).json(scheduledForCheck.body);
      return;
    }

    const { data: existing, error: fetchError } = await supabase
      .from("scheduled_posts")
      .select("id, status")
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (fetchError) {
      dbError(res, fetchError, "PATCH /scheduled-posts/:id/reschedule lookup");
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    if (existing.status !== "pending") {
      res.status(409).json({ error: "Only a pending post can be rescheduled." });
      return;
    }

    const { data, error, count } = await supabase
      .from("scheduled_posts")
      .update(
        {
          scheduled_for: scheduledForCheck.scheduledFor,
          // A rescheduled recurring occurrence is now a standalone one-off,
          // not "the Tuesday one moved" — detaching avoids colliding with
          // scheduled_posts_recurring_occurrence_key if the new time matches
          // another already-generated occurrence of the same series.
          recurring_schedule_id: null,
        },
        { count: "exact" },
      )
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .eq("status", "pending")
      .select()
      .maybeSingle();
    if (error) {
      // 23505 = unique_violation. Only realistic cause here is the
      // recurring-occurrence unique constraint above.
      if (error.code === "23505") {
        res.status(409).json({ error: "This account already has a post scheduled for that exact time." });
        return;
      }
      dbError(res, error, "PATCH /scheduled-posts/:id/reschedule");
      return;
    }
    if (!count || !data) {
      res.status(409).json({ error: "Only a pending post can be rescheduled." });
      return;
    }
    // google_event_id is already set on this row (it was already synced
    // when first created), so this correctly PATCHes the existing Calendar
    // event's time rather than creating a second one.
    void syncPostToCalendar(data.id);
    res.json(data);
  });

  // Pause/resume a single pending post without cancelling it — a
  // paused_at timestamp rather than a new status value (see migration
  // 0073's own comment for why): status stays 'pending' throughout, so
  // every other place that already gates on status='pending'
  // (releaseMediaIfOrphaned, DELETE /media/:id's in-use check, the
  // GET /scheduled-posts upcoming-list query) keeps working unchanged.
  // claimDuePosts() is the only place that needed to learn about this.
  router.patch("/scheduled-posts/:id/pause", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error, count } = await supabase
      .from("scheduled_posts")
      .update({ paused_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .eq("status", "pending")
      .is("paused_at", null)
      .select()
      .maybeSingle();
    if (error) {
      dbError(res, error, "PATCH /scheduled-posts/:id/pause");
      return;
    }
    if (!count || !data) {
      res.status(404).json({ error: "Not found, not owned by this caller, not pending, or already paused" });
      return;
    }
    // No calendar sync call — pausing doesn't change scheduled_for, and
    // eventMapper.ts doesn't mirror status/pause state onto the Calendar
    // event at all, so the mirrored event is already correct as-is.
    res.json(data);
  });

  router.patch("/scheduled-posts/:id/resume", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error, count } = await supabase
      .from("scheduled_posts")
      .update({ paused_at: null }, { count: "exact" })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .eq("status", "pending")
      .not("paused_at", "is", null)
      .select()
      .maybeSingle();
    if (error) {
      dbError(res, error, "PATCH /scheduled-posts/:id/resume");
      return;
    }
    if (!count || !data) {
      res.status(404).json({ error: "Not found, not owned by this caller, not pending, or not paused" });
      return;
    }
    res.json(data);
  });

  // Copy an existing post to a new day — reuses scheduleOnePost wholesale
  // (validatePostFields + checkFreeTierPostLimit + insert + calendar sync),
  // the exact same path a brand-new post goes through, since a duplicate
  // really is a brand-new row that happens to be pre-filled from another
  // one. Deliberately does NOT carry forward google_event_id/
  // google_updated_at/last_synced_at (scheduleOnePost's insert never sets
  // them, so they're correctly null on the new row — copying google_event_id
  // would violate its unique partial index) or recurring_schedule_id (also
  // never set by scheduleOnePost) — a duplicate is always a standalone
  // one-off, matching the reschedule route's own detach behavior above.
  router.post("/scheduled-posts/:id/duplicate", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: existing, error: fetchError } = await supabase
      .from("scheduled_posts")
      .select("social_account_id, content, media_url, cover_image_url, board_id, destination_link, first_comment, media_alt_text, status")
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (fetchError) {
      dbError(res, fetchError, "POST /scheduled-posts/:id/duplicate lookup");
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    if (existing.status === "draft" || existing.status === "posting") {
      res.status(400).json({ error: "Drafts and in-flight posts can't be duplicated this way" });
      return;
    }

    const result = await scheduleOnePost(req.accountId, {
      socialAccountId: existing.social_account_id,
      content: existing.content,
      mediaUrl: existing.media_url,
      coverImageUrl: existing.cover_image_url,
      boardId: existing.board_id,
      destinationLink: existing.destination_link,
      firstComment: existing.first_comment,
      mediaAltText: existing.media_alt_text,
      scheduledFor: (req.body ?? {}).scheduledFor,
      requiresApproval: (req.body ?? {}).requiresApproval,
    });
    res.status(result.status).json(result.body);
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

    // Awaited, not fire-and-forget like the other call sites — it needs to
    // read the row's google_event_id BEFORE the delete below removes it,
    // so it can't race the delete. deletePostFromCalendar never throws (see
    // its own internal try/catch) — a failed calendar cleanup still can't
    // block the delete itself, it just leaves a stale Calendar event behind
    // to clean up later rather than failing the customer's delete action.
    await deletePostFromCalendar(existing.id);

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
    destinationLink?: unknown;
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
   *  `status`) are skipped rather than required.
   *
   *  Async because mediaUrl/coverImageUrl need the same SSRF check as
   *  validatePostFields above — a recurring schedule's media_url is stored
   *  once here and then fetched server-side on every future occurrence
   *  without going through validatePostFields again, so an unsafe URL has
   *  to be caught at this write instead. */
  async function validateRecurringScheduleInput(input: RecurringScheduleInput, requireAll: boolean): Promise<string | null> {
    if (input.mediaUrl !== undefined && input.mediaUrl !== null) {
      if (typeof input.mediaUrl !== "string") return "mediaUrl must be a string";
      const result = await isSafeMediaUrl(input.mediaUrl);
      if (!result.safe) return `mediaUrl ${result.reason}`;
    }
    if (input.coverImageUrl !== undefined && input.coverImageUrl !== null && typeof input.coverImageUrl === "string") {
      const result = await isSafeMediaUrl(input.coverImageUrl);
      if (!result.safe) return `coverImageUrl ${result.reason}`;
    }
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
    if (input.destinationLink !== undefined && input.destinationLink !== null && typeof input.destinationLink !== "string") {
      return "destinationLink must be a string";
    }
    if (input.firstComment !== undefined && input.firstComment !== null && typeof input.firstComment !== "string") {
      return "firstComment must be a string";
    }
    return null;
  }

  router.post("/recurring-schedules", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const input = (req.body ?? {}) as RecurringScheduleInput;
    const validationError = await validateRecurringScheduleInput(input, true);
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
        destination_link: input.destinationLink ?? null,
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
    const validationError = await validateRecurringScheduleInput(input, false);
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
      input.boardId === undefined && input.destinationLink === undefined && input.firstComment === undefined &&
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
    if (input.destinationLink !== undefined) updates.destination_link = input.destinationLink;
    if (input.firstComment !== undefined) updates.first_comment = input.firstComment;
    if (input.daysOfWeek !== undefined) updates.days_of_week = input.daysOfWeek;
    if (input.timeOfDay !== undefined) updates.time_of_day = `${input.timeOfDay}:00`;
    if (input.timezone !== undefined) updates.timezone = input.timezone;
    if (input.startsOn !== undefined) updates.starts_on = input.startsOn;
    if (input.endsOn !== undefined) updates.ends_on = input.endsOn;
    if (input.status !== undefined) updates.status = input.status;

    // Ownership was already verified above (existing, fetched with
    // .eq("account_id", req.accountId)) — this update deliberately doesn't
    // repeat that filter, since it's the same synchronous request with no
    // TOCTOU window. If this line ever moves earlier, or the fetch above
    // is removed/reordered, add .eq("account_id", req.accountId) back here
    // too — found worth flagging by the 2026-08-26 IDOR audit.
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

    // Same reasoning as the PATCH handler above: ownership was already
    // verified via `existing` (fetched with .eq("account_id", req.accountId)),
    // so this delete doesn't repeat the filter — same synchronous request,
    // no TOCTOU window. Keep the account_id filter here if this line ever
    // moves earlier or the fetch above changes. Flagged by the 2026-08-26
    // IDOR audit.
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
      .select("tier, status, current_period_end, cancel_at_period_end")
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (error) {
      dbError(res, error, "GET /subscription");
      return;
    }
    if (!sub) {
      res.json({ tier: "free", status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false });
      return;
    }
    res.json({
      tier: sub.tier,
      status: sub.status,
      currentPeriodEnd: sub.current_period_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    });
  });

  // Starts a real Paddle checkout transaction for upgrading to a paid tier.
  // Only meaningful once MOR_API_KEY + the tier's price ID env vars exist
  // (see BILLING_KNOWLEDGE.md) — reports a clear error rather than a
  // confusing Paddle SDK exception if they don't.
  router.post("/subscription/checkout", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { tier } = req.body ?? {};
    if (tier !== "pro" && tier !== "business" && tier !== "enterprise" && tier !== "agency" && tier !== "agency_plus") {
      res.status(400).json({
        error:
          'tier must be "pro" (Starter), "business" (Pro), "enterprise" (Business), "agency" (Agency), or "agency_plus" (Agency Plus) — use the Free tier by just not upgrading',
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
          : tier === "enterprise"
            ? process.env.PADDLE_PRICE_ID_BUSINESS
            : tier === "agency"
              ? process.env.PADDLE_PRICE_ID_AGENCY
              : process.env.PADDLE_PRICE_ID_AGENCY_PLUS;
    if (!apiKey || !priceId) {
      res.status(503).json({
        error: "Billing isn't live yet — no Paddle account/price configured. See BILLING_KNOWLEDGE.md.",
      });
      return;
    }

    // Real gap found in the 2026-09-01 audit: this route had the same
    // check-then-act shape as /subscription/change-tier (see
    // pendingTierChanges' doc comment above) with no lock at all -- reject a
    // second concurrent checkout for this account outright, before touching
    // the DB or Paddle at all, same as change-tier already does.
    if (pendingTierChanges.has(req.accountId!)) {
      res.status(409).json({ error: "A subscription change is already in progress for this account. Please wait for it to finish." });
      return;
    }
    pendingTierChanges.add(req.accountId!);

    try {
      const { data: account, error: accountError } = await supabase
        .from("accounts")
        .select("email")
        .eq("id", req.accountId)
        .single();
      if (accountError || !account) {
        res.status(404).json({ error: "Account not found" });
        return;
      }

      // Real gap found in the 2026-08-25 pre-launch audit: nothing here
      // checked whether the account already had an active/trialing
      // subscription before starting a fresh Paddle checkout. A stale second
      // tab, or a resubmitted request, could create a SECOND, independent
      // Paddle subscription -- the local subscriptions row only ever holds
      // one (onConflict: "account_id"), so whichever webhook lands last
      // silently overwrites the tracked mor_subscription_id and the app loses
      // all ability to see or cancel the orphaned first subscription, which
      // keeps billing the customer indefinitely. Existing customers upgrading
      // between paid tiers already have their own dedicated endpoint
      // (/subscription/change-tier) -- this one is Free-to-paid only.
      const { data: existingSub, error: existingSubError } = await supabase
        .from("subscriptions")
        .select("status")
        .eq("account_id", req.accountId)
        .maybeSingle();
      if (existingSubError) {
        dbError(res, existingSubError, "POST /subscription/checkout");
        return;
      }
      if (existingSub && (existingSub.status === "active" || existingSub.status === "trialing")) {
        res.status(400).json({
          error: "You already have an active plan. Use the dashboard's upgrade/downgrade option to switch tiers instead.",
        });
        return;
      }

      const environment = process.env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox;
      try {
        const { transactionId, checkoutUrl } = await buildCheckoutTransaction(apiKey, environment, {
          kind: "tier",
          accountEmail: account.email,
          accountId: req.accountId!,
          tier,
          priceId,
        });
        res.json({ transactionId, checkoutUrl });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      pendingTierChanges.delete(req.accountId!);
    }
  });

  // Changes an EXISTING active subscription's tier in place (real proration,
  // not a fresh checkout) — found 2026-08-21 that the dashboard had no
  // self-serve upgrade/downgrade path at all once a customer was already
  // paying, only cancel-and-lose-access. /subscription/checkout above is
  // for going from Free (or a lapsed/cancelled account) to a paid tier;
  // this is for moving between paid tiers. See changeSubscriptionTier's doc
  // comment in billing/types.ts for why no local DB write happens here —
  // the resulting webhook is the source of truth, same as every other
  // subscription-lifecycle change.
  router.post("/subscription/change-tier", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { tier } = req.body ?? {};
    if (tier !== "pro" && tier !== "business" && tier !== "enterprise" && tier !== "agency" && tier !== "agency_plus") {
      res.status(400).json({
        error:
          'tier must be "pro" (Starter), "business" (Pro), "enterprise" (Business), "agency" (Agency), or "agency_plus" (Agency Plus)',
      });
      return;
    }

    const apiKey = process.env.MOR_API_KEY;
    const priceId =
      tier === "pro"
        ? process.env.PADDLE_PRICE_ID_STARTER
        : tier === "business"
          ? process.env.PADDLE_PRICE_ID_PRO
          : tier === "enterprise"
            ? process.env.PADDLE_PRICE_ID_BUSINESS
            : tier === "agency"
              ? process.env.PADDLE_PRICE_ID_AGENCY
              : process.env.PADDLE_PRICE_ID_AGENCY_PLUS;
    if (!apiKey || !priceId) {
      res.status(503).json({
        error: "Billing isn't live yet — no Paddle account/price configured. See BILLING_KNOWLEDGE.md.",
      });
      return;
    }

    // Reject a second concurrent change-tier request for this account
    // outright, before touching the DB or Paddle at all -- see
    // pendingTierChanges' doc comment above for why this exists.
    if (pendingTierChanges.has(req.accountId!)) {
      res.status(409).json({ error: "A tier change is already in progress for this account. Please wait for it to finish." });
      return;
    }
    pendingTierChanges.add(req.accountId!);

    try {
      const { data: account, error: accountError } = await supabase
        .from("accounts")
        .select("email")
        .eq("id", req.accountId)
        .single();
      if (accountError || !account) {
        res.status(404).json({ error: "Account not found" });
        return;
      }

      const { data: subscription, error: subError } = await supabase
        .from("subscriptions")
        .select("mor_subscription_id, tier, status")
        .eq("account_id", req.accountId)
        .maybeSingle();
      if (subError) {
        dbError(res, subError, "POST /subscription/change-tier");
        return;
      }
      if (!subscription || (subscription.status !== "active" && subscription.status !== "trialing")) {
        res.status(400).json({ error: "No active subscription to change — subscribe via /subscription/checkout first." });
        return;
      }
      if (subscription.tier === tier) {
        res.status(400).json({ error: "Already on this tier." });
        return;
      }

      const result = await morAdapter.changeSubscriptionTier(subscription.mor_subscription_id, priceId, tier, account.email, req.accountId!);
      if (!result.success) {
        res.status(502).json({ error: result.errorMessage ?? "Tier change failed at the payment provider" });
        return;
      }
      res.json({ changed: true });
    } finally {
      pendingTierChanges.delete(req.accountId!);
    }
  });

  // The cancellation flow — this is THE trust-critical endpoint. Cancels
  // with the Merchant of Record first; only then does the local record
  // get marked cancelled. See billing/sync.ts for the full reasoning.
  router.post("/subscription/cancel", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { feedback, acknowledgedDataDeletion } = req.body ?? {};
    const result = await cancelSubscription(
      req.accountId!,
      morAdapter,
      typeof feedback === "string" ? feedback : undefined,
      acknowledgedDataDeletion === true,
    );
    if (!result.success) {
      // Missing acknowledgement is a caller error, not a payment-provider
      // failure -- keep it distinguishable from the 502 case below so the
      // frontend can tell "you forgot to check the box" apart from "Paddle
      // itself rejected this."
      const status = result.errorMessage?.startsWith("You must acknowledge") ? 400 : 502;
      res.status(status).json({ error: result.errorMessage ?? "Cancellation failed at the payment provider" });
      return;
    }
    res.json({ cancelled: true });
  });

  // Lists the caller's active/trialing storage add-ons — the "manage your
  // extra storage" view alongside the storage gauge.
  router.get("/storage-addons", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("storage_addons")
      .select("id, gb_amount, status, current_period_end, cancel_at_period_end")
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
  router.post("/storage-addons/checkout", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
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
        accountId: req.accountId!,
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
  router.post("/storage-addons/:id/cancel", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const result = await cancelStorageAddon(req.accountId!, String(req.params.id), morAdapter);
    if (!result.success) {
      res.status(502).json({ error: result.errorMessage ?? "Cancellation failed at the payment provider" });
      return;
    }
    res.json({ cancelled: true });
  });

  // Brand add-ons (Phase 1b, 2026-08-16) — same three-route shape as storage
  // add-ons above (list / checkout / cancel), but the list response also
  // carries the account's real effective brand capacity (base tier limit +
  // active add-on slots) so the frontend can show "N/cap" honestly without a
  // second round trip.
  router.get("/brand-addons", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const [{ data, error }, capacity] = await Promise.all([
      supabase
        .from("brand_addons")
        .select("id, status, current_period_end, cancel_at_period_end")
        .eq("account_id", req.accountId)
        .in("status", ["active", "trialing"])
        .order("created_at", { ascending: true }),
      getBrandCapacity(req.accountId!),
    ]);
    if (error) {
      dbError(res, error, "GET /brand-addons");
      return;
    }
    res.json({ addons: data, baseLimit: capacity.baseLimit, addonSlots: capacity.addonSlots, totalLimit: capacity.totalLimit });
  });

  // Starts a real Paddle checkout transaction for one brand add-on (+1 brand
  // slot). Same free-tier exclusion and pattern as /storage-addons/checkout —
  // a customer already on a paid tier who wants MORE brands than their
  // tier's base allowance.
  router.post("/brand-addons/checkout", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const tier = await resolveTier(req.accountId!);
    if (tier === "free") {
      res.status(403).json({ error: "Brand add-ons aren't available on the Free tier — upgrade to a paid plan first." });
      return;
    }

    const { count: activeAddonCount, error: countError } = await supabase
      .from("brand_addons")
      .select("id", { count: "exact", head: true })
      .eq("account_id", req.accountId)
      .in("status", ["active", "trialing"]);
    if (countError) {
      dbError(res, countError, "POST /brand-addons/checkout active-count");
      return;
    }
    if ((activeAddonCount ?? 0) >= MAX_ACTIVE_BRAND_ADDONS) {
      res.status(403).json({
        error: `You already have ${MAX_ACTIVE_BRAND_ADDONS} brand add-ons — cancel one before adding another, or talk to us about an Agency plan.`,
      });
      return;
    }

    const apiKey = process.env.MOR_API_KEY;
    const priceId = process.env[BRAND_ADDON_PRICE_ID_ENV_VAR];
    if (!apiKey || !priceId) {
      res.status(503).json({ error: "Billing isn't live yet — no Paddle price configured for this add-on." });
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
        kind: "brand_addon",
        accountEmail: account.email,
        accountId: req.accountId!,
        priceId,
      });
      res.json({ transactionId, checkoutUrl });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Cancels a single brand add-on — does not touch the account's main tier
  // subscription. See billing/sync.ts's cancelBrandAddon.
  router.post("/brand-addons/:id/cancel", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const result = await cancelBrandAddon(req.accountId!, String(req.params.id), morAdapter);
    if (!result.success) {
      res.status(502).json({ error: result.errorMessage ?? "Cancellation failed at the payment provider" });
      return;
    }
    res.json({ cancelled: true });
  });

  // Seat add-ons (Agency pricing pass, 2026-08-17) — same three-route shape
  // as brand add-ons above, but with a stricter tier gate: brand add-ons are
  // buyable on any paid tier, while seats only exist on Business/Agency/
  // Agency Plus (see SEAT_LIMITS in seatLimits.ts) — so this excludes "pro"
  // and "business" (internal codes; Starter/Pro displayed), not just "free".
  router.get("/seat-addons", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const [{ data, error }, capacity] = await Promise.all([
      supabase
        .from("seat_addons")
        .select("id, status, current_period_end, cancel_at_period_end")
        .eq("account_id", req.accountId)
        .in("status", ["active", "trialing"])
        .order("created_at", { ascending: true }),
      getSeatCapacity(req.accountId!),
    ]);
    if (error) {
      dbError(res, error, "GET /seat-addons");
      return;
    }
    res.json({ addons: data, baseLimit: capacity.baseLimit, addonSlots: capacity.addonSlots, totalLimit: capacity.totalLimit });
  });

  router.post("/seat-addons/checkout", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const tier = await resolveTier(req.accountId!);
    if (tier !== "enterprise" && tier !== "agency" && tier !== "agency_plus") {
      res.status(403).json({ error: "Seat add-ons are only available on Business, Agency, or Agency Plus — upgrade first." });
      return;
    }

    const { count: activeAddonCount, error: countError } = await supabase
      .from("seat_addons")
      .select("id", { count: "exact", head: true })
      .eq("account_id", req.accountId)
      .in("status", ["active", "trialing"]);
    if (countError) {
      dbError(res, countError, "POST /seat-addons/checkout active-count");
      return;
    }
    if ((activeAddonCount ?? 0) >= MAX_SEAT_ADDONS_PER_ACCOUNT) {
      res.status(403).json({
        error: `You already have ${MAX_SEAT_ADDONS_PER_ACCOUNT} seat add-ons — cancel one before adding another.`,
      });
      return;
    }

    const apiKey = process.env.MOR_API_KEY;
    const priceId = process.env[SEAT_ADDON_PRICE_ID_ENV_VAR];
    if (!apiKey || !priceId) {
      res.status(503).json({ error: "Billing isn't live yet — no Paddle price configured for this add-on." });
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
        kind: "seat_addon",
        accountEmail: account.email,
        accountId: req.accountId!,
        priceId,
      });
      res.json({ transactionId, checkoutUrl });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Cancels a single seat add-on — does not touch the account's main tier
  // subscription. See billing/sync.ts's cancelSeatAddon.
  router.post("/seat-addons/:id/cancel", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const result = await cancelSeatAddon(req.accountId!, String(req.params.id), morAdapter);
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
      .select("email, business_name, email_failure_alerts_enabled, webhook_url, webhook_secret, voice_profile")
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
      // Default AI-caption/hashtag voice (migration 0061) — overridden per
      // brand when the account being posted from belongs to one with its
      // own voice_profile set; see resolveVoiceProfile in the /ai/* routes.
      voiceProfile: data.voice_profile,
    });
  });

  router.patch("/account", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { businessName, emailFailureAlertsEnabled, webhookUrl, voiceProfile } = req.body ?? {};
    if (businessName !== undefined && businessName !== null && typeof businessName !== "string") {
      res.status(400).json({ error: "businessName must be a string or null" });
      return;
    }
    if (typeof businessName === "string" && businessName.length > 80) {
      res.status(400).json({ error: "businessName must be 80 characters or fewer" });
      return;
    }
    if (voiceProfile !== undefined && voiceProfile !== null && typeof voiceProfile !== "string") {
      res.status(400).json({ error: "voiceProfile must be a string or null" });
      return;
    }
    if (typeof voiceProfile === "string" && voiceProfile.length > MAX_VOICE_PROFILE_LENGTH) {
      res.status(400).json({ error: `voiceProfile must be ${MAX_VOICE_PROFILE_LENGTH} characters or fewer` });
      return;
    }
    // businessName becomes the inviter label in a team-invite email subject
    // (email.ts's sendTeamInviteEmail) — stripping newlines here is cheap
    // defense-in-depth against header injection if the Resend API ever
    // passes a subject through to a raw SMTP header without folding it,
    // rather than depending entirely on a third party's own sanitization.
    if (typeof businessName === "string" && /[\r\n]/.test(businessName)) {
      res.status(400).json({ error: "businessName can't contain line breaks" });
      return;
    }
    // Reserved-prefix check (2026-08-30, see the signup-time check above
    // for the reasoning) — exempts a no-op re-save of the account's OWN
    // already-set name, since LazyRelay's own dogfooding account is
    // literally named "LazyRelay" and would otherwise be unable to hit
    // Save on its own Settings page without changing anything.
    if (typeof businessName === "string" && businessName.trim() && isReservedBusinessName(businessName.trim())) {
      const { data: current } = await supabase.from("accounts").select("business_name").eq("id", req.accountId).maybeSingle();
      const currentNormalized = current?.business_name?.trim().toLowerCase();
      if (businessName.trim().toLowerCase() !== currentNormalized) {
        res.status(400).json({ error: "That name isn't available — try a different one." });
        return;
      }
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
    if (webhookUrl !== undefined && req.authMethod === "jwt" && req.role !== "owner") {
      res.status(403).json({ error: "Only the account owner can change webhook settings." });
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
      // scheduler.ts fetches this URL server-side every time a post is
      // confirmed live — same class of SSRF as mediaUrl/coverImageUrl
      // (routes.ts's validatePostFields), so it gets the same guard. This
      // was the one place that class of check had been missed.
      const safety = await isSafeMediaUrl(trimmed);
      if (!safety.safe) {
        res.status(400).json({ error: `webhookUrl ${safety.reason}` });
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
    if (voiceProfile !== undefined) update.voice_profile = voiceProfile?.trim() || null;
    if (normalizedWebhookUrl !== undefined) {
      update.webhook_url = normalizedWebhookUrl;
      if (normalizedWebhookUrl === null) update.webhook_secret = null;
      else if (newWebhookSecret) update.webhook_secret = newWebhookSecret;
    }
    const { data, error } = await supabase
      .from("accounts")
      .update(update)
      .eq("id", req.accountId)
      .select("email, business_name, email_failure_alerts_enabled, webhook_url, webhook_secret, voice_profile")
      .single();
    if (error) {
      // 23505 = the case-insensitive unique index on lower(business_name)
      // (migration 0074) — same pattern as POST/PATCH /brands.
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({ error: "That business name is already taken — try a different one." });
        return;
      }
      dbError(res, error, "PATCH /account");
      return;
    }
    if (!data) {
      dbError(res, { message: "update returned no row" }, "PATCH /account");
      return;
    }
    res.json({
      email: data.email,
      businessName: data.business_name,
      emailFailureAlertsEnabled: data.email_failure_alerts_enabled,
      webhookUrl: data.webhook_url,
      webhookConfigured: !!data.webhook_secret,
      voiceProfile: data.voice_profile,
      // Only present the one time a secret is newly generated — same
      // "shown once, save it now" pattern as API key creation.
      ...(newWebhookSecret ? { webhookSecret: newWebhookSecret } : {}),
    });
  });

  // Lets a customer rotate a compromised/leaked webhook secret without
  // having to also change (and re-register with their own systems) the
  // webhook URL itself. Human-dashboard-only, same reasoning as the
  // webhookUrl check in PATCH /account above.
  router.post("/account/webhook/regenerate-secret", requireAuth, requireHumanAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
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
  router.post("/api-keys", requireAuth, requireHumanAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    // Pricing has always advertised "AI-agent / MCP access" as a paid-tier
    // perk, but this route had no tier check at all until now (found live
    // by a site audit, confirmed as a real gap by Werner 2026-08-10, not
    // just stale copy) -- same paid-tier-gate pattern already used for
    // recurring schedules and storage add-ons above.
    const tier = await resolveTier(req.accountId!);
    if (tier === "free") {
      res.status(403).json({ error: "API keys are a paid-tier feature. Upgrade to Starter, Pro, or Business for API and MCP access." });
      return;
    }
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

  router.delete("/api-keys/:id", requireAuth, requireHumanAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
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

  // Agency tier v1 (migration 0053, account_members). Deliberately not
  // tier-gated yet -- Werner hasn't set Agency-tier pricing/seat limits, so
  // gating this on a specific paid tier now would mean inventing a pricing
  // rule rather than following one. Any account can use it today; adding a
  // tier check here is the natural place once that pricing decision exists.
  router.get("/team", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("account_members")
      .select("id, user_id, invited_email, role, invited_at, accepted_at")
      .eq("account_id", req.accountId)
      .order("invited_at", { ascending: true });
    if (error) {
      dbError(res, error, "GET /team");
      return;
    }
    res.json(data);
  });

  router.post("/team/invite", requireAuth, requireHumanAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const seatLimitError = await checkSeatLimit(req.accountId!);
    if (seatLimitError) {
      res.status(403).json({ error: seatLimitError });
      return;
    }

    const { email } = req.body ?? {};
    if (typeof email !== "string" || !/^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(email.trim())) {
      res.status(400).json({ error: "A valid email is required" });
      return;
    }
    const normalizedEmail = email.trim().toLowerCase();

    const { data: account } = await supabase.from("accounts").select("email, business_name").eq("id", req.accountId).maybeSingle();
    if (account?.email && account.email.toLowerCase() === normalizedEmail) {
      res.status(400).json({ error: "That's your own email address" });
      return;
    }

    const { data: existing } = await supabase
      .from("account_members")
      .select("id, accepted_at")
      .eq("account_id", req.accountId)
      .ilike("invited_email", normalizedEmail)
      .maybeSingle();
    if (existing) {
      res.status(409).json({ error: existing.accepted_at ? "Already a team member" : "Already invited, waiting on acceptance" });
      return;
    }

    const { data: invite, error } = await supabase
      .from("account_members")
      .insert({ account_id: req.accountId, invited_email: normalizedEmail, role: "member" })
      .select("id, invite_token")
      .single();
    if (error || !invite) {
      dbError(res, error ?? { message: "insert returned no row" }, "POST /team/invite");
      return;
    }

    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
    const acceptUrl = `${frontendUrl}/team/accept?token=${invite.invite_token}`;
    sendTeamInviteEmail(normalizedEmail, account?.business_name || account?.email || "A LazyRelay account", acceptUrl);

    res.status(201).json({ id: invite.id, email: normalizedEmail, role: "member" });
  });

  router.delete("/team/:id", requireAuth, requireHumanAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: member } = await supabase
      .from("account_members")
      .select("id, account_id, role")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!member || member.account_id !== req.accountId) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }
    if (member.role === "owner") {
      res.status(400).json({ error: "The account owner can't be removed" });
      return;
    }
    const { error } = await supabase.from("account_members").delete().eq("id", req.params.id);
    if (error) {
      dbError(res, error, "DELETE /team/:id");
      return;
    }
    res.status(204).end();
  });

  // Resends a still-pending invite -- same email, same invite_token (no
  // reason to rotate it; an old copy of the email still working alongside
  // the new one is harmless, not a security concern), just a fresh
  // invited_at so it's good for another 72 hours (see TEAM_INVITE_EXPIRY_MS
  // in POST /team/accept-invite above). Real gap Werner asked to close,
  // 2026-08-17: without this, a missed/expired invite email meant deleting
  // the row and starting over instead of one click.
  router.post("/team/:id/resend", requireAuth, requireHumanAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: member } = await supabase
      .from("account_members")
      .select("id, account_id, invited_email, user_id, accepted_at, invite_token")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!member || member.account_id !== req.accountId) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }
    if (member.user_id || member.accepted_at) {
      res.status(400).json({ error: "This invite has already been accepted, there's nothing to resend" });
      return;
    }

    const { error } = await supabase
      .from("account_members")
      .update({ invited_at: new Date().toISOString() })
      .eq("id", member.id);
    if (error) {
      dbError(res, error, "POST /team/:id/resend");
      return;
    }

    const { data: account } = await supabase.from("accounts").select("email, business_name").eq("id", req.accountId).maybeSingle();
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
    const acceptUrl = `${frontendUrl}/team/accept?token=${member.invite_token}`;
    sendTeamInviteEmail(member.invited_email!, account?.business_name || account?.email || "A LazyRelay account", acceptUrl);

    res.json({ resent: true });
  });

  // requireJwtUser, not requireAuth -- see its doc comment in auth.ts. This
  // is the one route where "who is calling" must be resolved independently
  // of account-membership lookup, since accepting is the act that creates
  // that membership in the first place.
  router.post("/team/accept-invite", requireJwtUser, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { token } = req.body ?? {};
    if (typeof token !== "string" || token.trim().length === 0) {
      res.status(400).json({ error: "token is required" });
      return;
    }
    const { data: invite } = await supabase
      .from("account_members")
      .select("id, account_id, invited_email, user_id, accepted_at, invited_at")
      .eq("invite_token", token.trim())
      .maybeSingle();
    if (!invite || invite.user_id || invite.accepted_at) {
      res.status(404).json({ error: "This invite is invalid or has already been used" });
      return;
    }
    if (Date.now() - new Date(invite.invited_at).getTime() > TEAM_INVITE_EXPIRY_MS) {
      res.status(410).json({ error: "This invite has expired. Ask the account owner to resend it." });
      return;
    }
    if (!invite.invited_email || invite.invited_email.toLowerCase() !== req.jwtUser!.email.toLowerCase()) {
      res.status(403).json({ error: "This invite was sent to a different email address" });
      return;
    }

    // v1's stated limit: at most one OTHER account beyond your own -- see
    // resolveAccountForUser() in auth.ts. Checked here, at the one moment
    // the conflict can actually be created, rather than guessed at invite time.
    const { data: existingMembership } = await supabase
      .from("account_members")
      .select("id")
      .eq("user_id", req.jwtUser!.id)
      .eq("role", "member")
      .not("accepted_at", "is", null)
      .maybeSingle();
    if (existingMembership) {
      res.status(409).json({ error: "You're already a member of another team. Leave that one first." });
      return;
    }

    const { error } = await supabase
      .from("account_members")
      .update({ user_id: req.jwtUser!.id, accepted_at: new Date().toISOString() })
      .eq("id", invite.id)
      .is("user_id", null); // race guard, same pattern as admin_key_intents
    if (error) {
      dbError(res, error, "POST /team/accept-invite");
      return;
    }
    res.json({ accountId: invite.account_id });
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
  // Real bug found in a security review, 2026-08-19: this route was
  // reachable by ANY signed-up customer, not just Werner — requireHumanAuth
  // only excludes API-key/admin-key auth, it says nothing about WHICH human.
  // That defeated the entire point of migration 0037's admin-key guard: any
  // customer (a free $0 signup is enough) could open the 10-minute approval
  // window that lets a leaked lzr_admin_ key bypass its own auto-revoke.
  // OPERATOR_ACCOUNT_IDS is a comma-separated allowlist of Werner's own
  // known account ids (set in .env/Render, never customer-editable) — the
  // simplest fix that doesn't require inventing a new schema concept for
  // something only one person needs today.
  const operatorAccountIds = new Set(
    (process.env.OPERATOR_ACCOUNT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean),
  );
  router.post("/admin/announce", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    if (!req.accountId || !operatorAccountIds.has(req.accountId)) {
      res.status(403).json({ error: "This endpoint is restricted." });
      return;
    }
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
