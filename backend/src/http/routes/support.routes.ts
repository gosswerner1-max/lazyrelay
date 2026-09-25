// support routes — extracted verbatim from the original single buildRouter()
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
import { resolveOptionalAccountId } from "../auth.js";
import { publicRateLimit, supportChatPerIpDailyLimit } from "../rateLimit.js";
import { getStorageUsage } from "../../storageQuota.js";
import { TIER_DISPLAY_NAMES } from "../../tier.js";
import { buildSupportSystemPrompt, type SupportAccountContext } from "../../support/chatKnowledge.js";
import { extractSelfReportedEmail, SELF_REPORTED_EMAIL } from "../../support/escalationIdentity.js";
import { sendSupportEscalation } from "../../email.js";
import { dbError, readAnalyticsConsent } from "./shared.js";
import { validateBody } from "../validation.js";

export function buildSupportRouter(): Router {
  const router = Router();

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
  // this route costs real Anthropic spend per call. At today's near-zero
  // real traffic this should never actually trigger; it exists purely to
  // cap a scripted abuse attempt. See increment_support_chat_usage in
  // migration 0056. SECURITY FIX (2026-09-14): this alone couldn't stop
  // one actor from draining the whole day's shared budget -- see
  // supportChatPerIpDailyLimit (rateLimit.ts) for the per-IP daily
  // ceiling now layered on top of this global one.
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
  // The array's own shape (non-empty, capped) is checked before any single
  // message is — `.pipe()` only runs the per-message schema once the array
  // check passed, matching the old check order.
  const CHAT_MESSAGES_ERROR = `messages must be a non-empty array of at most ${MAX_CHAT_MESSAGES} items`;
  const CHAT_MESSAGE_ERROR = "each message needs a role of user/assistant and non-empty content";
  const supportChatBodySchema = z.object({
    messages: z
      .array(z.unknown(), { error: CHAT_MESSAGES_ERROR })
      .min(1, CHAT_MESSAGES_ERROR)
      .max(MAX_CHAT_MESSAGES, CHAT_MESSAGES_ERROR)
      .pipe(
        z.array(
          z.object(
            {
              role: z.enum(["user", "assistant"], { error: CHAT_MESSAGE_ERROR }),
              content: z
                .string({ error: CHAT_MESSAGE_ERROR })
                .min(1, CHAT_MESSAGE_ERROR)
                .max(MAX_CHAT_MESSAGE_LENGTH, CHAT_MESSAGE_ERROR),
            },
            { error: CHAT_MESSAGE_ERROR },
          ),
        ),
      ),
  });
  router.post("/support/chat", publicRateLimit, supportChatPerIpDailyLimit, async (req, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "The support assistant isn't set up on this deploy yet." });
      return;
    }
    const body = validateBody(supportChatBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { messages } = body.data;
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
      const client = createAnthropicClient(apiKey, 30_000, readAnalyticsConsent(req));
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

  return router;
}
