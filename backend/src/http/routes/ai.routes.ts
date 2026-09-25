// ai routes — extracted verbatim from the original single buildRouter()
// in http/routes.ts (split 2026-09-25, pure mechanical move: same paths,
// same middleware order, same handler bodies). http/routes.ts mounts this.
// Follow-up the same day: hand-written request-body type/length checks
// replaced with zod schemas (see http/validation.ts) — same messages, same
// accept/reject rules, same order.

import { Router } from "express";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicClient } from "../../posthogClient.js";
import { supabase } from "../../supabase.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { MAX_POST_CONTENT_LENGTH } from "../../postCreation.js";
import { checkGenerationLimit, recordGeneration } from "../../aiUsage.js";
import { readAnalyticsConsent } from "./shared.js";
import { validateBody, nonEmptyString, unvalidated } from "../validation.js";

export function buildAiRouter(): Router {
  const router = Router();

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
  const captionBodySchema = z.object({
    topic: nonEmptyString("topic must be a non-empty string").max(
      MAX_CAPTION_TOPIC_LENGTH,
      `topic must be ${MAX_CAPTION_TOPIC_LENGTH} characters or fewer`,
    ),
    platform: unvalidated(),
    tone: unvalidated(),
    socialAccountId: unvalidated(),
  });
  router.post("/ai/caption", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "AI caption generation isn't set up on this deploy yet." });
      return;
    }
    const body = validateBody(captionBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { topic, platform, tone, socialAccountId } = body.data;
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
      const client = createAnthropicClient(apiKey, 20_000, readAnalyticsConsent(req));
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
  const hashtagsBodySchema = z.object({
    content: nonEmptyString("content must be a non-empty string").max(
      MAX_POST_CONTENT_LENGTH,
      `content must be ${MAX_POST_CONTENT_LENGTH} characters or fewer`,
    ),
    platform: unvalidated(),
    socialAccountId: unvalidated(),
  });
  router.post("/ai/hashtags", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "AI hashtag suggestions aren't set up on this deploy yet." });
      return;
    }
    const body = validateBody(hashtagsBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { content, platform, socialAccountId } = body.data;
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
      const client = createAnthropicClient(apiKey, 20_000, readAnalyticsConsent(req));
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

    const { data: account } = await req.db!.from("accounts").select("business_name").eq("id", req.accountId).maybeSingle();
    const { data: recentPosts } = await req.db!
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
      const client = createAnthropicClient(apiKey, 20_000, readAnalyticsConsent(req));
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

  return router;
}
