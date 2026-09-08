import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
  CommentsResult,
  CommentPostResult,
  DMConversationsResult,
  DMMessagesResult,
  SendDMResult,
} from "./types.js";
import { fetchMediaForStreaming, buildStreamingMultipartBody, type RequestInitWithDuplex } from "./streamUpload.js";

// REDESIGNED 2026-09-08 — was a single shared bot (@lazyrelay_bot) across
// every customer. That let posting work (Telegram scopes a bot's API calls
// to whatever chats it's an admin/member of, so one bot token was enough
// to POST to many channels), but made comment/DM *reading* impossible to
// route correctly: every customer's bot updates would arrive mixed
// together on the one shared token with no reliable way to attribute an
// incoming message to the right customer. Competitive research the same
// day found Publora solves this exact problem with customer-owned bot
// tokens instead of a shared one -- adopted that model here. Zero real
// customers were connected under the old model at the time of this change
// (confirmed live against social_accounts, one internal test channel
// only), so this is a clean redesign, not a migration.
//
// New flow: the customer creates their own bot via @BotFather (a few taps
// in Telegram, no developer account needed), adds it as Administrator with
// "Post Messages" rights on their channel, then pastes the bot token and
// channel @username into LazyRelay's connect page. `accessToken` stores
// both as JSON (`{"botToken":"...","chatId":"..."}`) rather than just the
// chat id -- every API call now authenticates as that customer's own bot,
// never a class-level shared secret.
const API_BASE = "https://api.telegram.org";

interface TelegramChat {
  id: number;
  title?: string;
  username?: string;
  type?: string;
  linked_chat_id?: number;
}

interface TelegramChatMember {
  status?: string;
  can_post_messages?: boolean;
}

interface TelegramUser {
  id: number;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramMessage {
  message_id: number;
}

interface TelegramFrom {
  id: number;
  first_name?: string;
  username?: string;
}

interface TelegramUpdateMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  from?: TelegramFrom;
  chat: { id: number; type: string };
  reply_to_message?: { forward_from_message_id?: number; message_id?: number };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramUpdateMessage;
}

interface TelegramCredentials {
  botToken: string;
  chatId: string;
}

function parseCredentials(accessToken: string): TelegramCredentials {
  try {
    const parsed = JSON.parse(accessToken) as Partial<TelegramCredentials>;
    if (!parsed.botToken || !parsed.chatId) throw new Error("missing field");
    return { botToken: parsed.botToken, chatId: parsed.chatId };
  } catch {
    throw new Error("Corrupt Telegram credentials — reconnect this account");
  }
}

export class TelegramAdapter implements PlatformAdapter {
  readonly platform: "telegram" = "telegram";

  // connectPageUrl mirrors Bluesky's not-yet-built connect-form pattern.
  // logChatId is optional and now customer-specific rather than global
  // (see exchangeCode) — a private chat *that customer's own bot* can
  // copyMessage into for real per-message Proof-of-Publish verification
  // (see verifyPublished below for why this matters) — Telegram's Bot API
  // has no GET-by-message-id endpoint, confirmed live, so without a
  // configured log chat this adapter is honest about only being able to
  // confirm the *channel* is still reachable, not that a specific message
  // still exists.
  constructor(private readonly connectPageUrl: string) {}

  private async callApi<T>(botToken: string, method: string, params: Record<string, string>): Promise<TelegramApiResponse<T>> {
    const res = await fetch(`${API_BASE}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    return (await res.json()) as TelegramApiResponse<T>;
  }

  // sendVideo via real multipart upload rather than passing mediaUrl
  // directly as Telegram's `video` field -- confirmed live 2026-09-05
  // (core.telegram.org/bots/api#sending-files): Telegram fetching a URL
  // itself caps at 20MB, while a genuine multipart upload allows the real
  // 50MB ceiling. Streamed rather than buffered (see streamUpload.ts) so
  // this doesn't reintroduce the whole-file-in-memory problem the rest of
  // this build is fixing.
  private async sendVideoFile(botToken: string, chatId: string, mediaUrl: string, caption: string): Promise<TelegramApiResponse<TelegramMessage>> {
    const media = await fetchMediaForStreaming(mediaUrl);
    if (!media) {
      return { ok: false, description: `Could not fetch video from ${mediaUrl}` };
    }
    const { body, contentType, contentLength } = buildStreamingMultipartBody([
      { fieldName: "chat_id", value: chatId },
      { fieldName: "caption", value: caption },
      { fieldName: "video", value: { filename: "video.mp4", contentType: media.contentType, data: media.body, sizeBytes: media.sizeBytes } },
    ]);
    // Content-Length set whenever known -- some upload endpoints reject a
    // chunked-transfer body outright (confirmed on Pinterest's S3-style
    // upload, HTTP 411); passing sizeBytes above lets it be computed
    // without buffering the file (see buildStreamingMultipartBody).
    const res = await fetch(`${API_BASE}/bot${botToken}/sendVideo`, {
      method: "POST",
      headers: { "Content-Type": contentType, ...(contentLength != null ? { "Content-Length": String(contentLength) } : {}) },
      body,
      duplex: "half",
    } as RequestInitWithDuplex);
    return (await res.json()) as TelegramApiResponse<TelegramMessage>;
  }

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({ state });
    return `${this.connectPageUrl}?${params.toString()}`;
  }

  // `code` here is a JSON string `{"botToken":"...","channelUsername":"@mychannel"}`
  // — the customer's own bot, created via @BotFather, not LazyRelay's. See
  // the class-level comment for why there's no real OAuth code to exchange
  // and why this moved off a single shared bot.
  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    let botToken: string;
    let channelUsername: string;
    try {
      const parsed = JSON.parse(code) as { botToken?: string; channelUsername?: string };
      if (!parsed.botToken || !parsed.channelUsername) throw new Error("missing field");
      botToken = parsed.botToken;
      channelUsername = parsed.channelUsername;
    } catch {
      throw new Error("Telegram connect requires your bot's token (from @BotFather) and the channel's @username");
    }

    const meRes = await this.callApi<TelegramUser>(botToken, "getMe", {});
    if (!meRes.ok || !meRes.result) {
      throw new Error(meRes.description ?? "That doesn't look like a valid bot token — check what @BotFather gave you");
    }

    const chatRes = await this.callApi<TelegramChat>(botToken, "getChat", { chat_id: channelUsername });
    if (!chatRes.ok || !chatRes.result) {
      throw new Error(chatRes.description ?? "Could not find that Telegram channel — make sure the @username is correct and public");
    }
    const chat = chatRes.result;

    const memberRes = await this.callApi<TelegramChatMember>(botToken, "getChatMember", {
      chat_id: channelUsername,
      user_id: String(meRes.result.id),
    });
    const member = memberRes.result;
    if (!memberRes.ok || !member || member.status !== "administrator" || member.can_post_messages !== true) {
      throw new Error("Your bot must be added as an Administrator with \"Post Messages\" permission on this channel before connecting it");
    }

    return {
      accessToken: JSON.stringify({ botToken, chatId: String(chat.id) } satisfies TelegramCredentials),
      refreshToken: null,
      // Bot admin rights don't expire on a timer the way OAuth tokens do —
      // they last until the customer removes the bot from the channel.
      expiresAt: null,
      platformAccountId: String(chat.id),
      displayName: chat.title ?? chat.username ?? channelUsername,
    };
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const { botToken, chatId } = parseCredentials(request.accessToken);
    const isVideo = !!request.mediaUrl && /\.(mp4|mov|m4v|webm)(\?.*)?$/i.test(request.mediaUrl);

    // Video support added 2026-09-05 (core.telegram.org/bots/api#sendvideo,
    // confirmed live): real multipart upload via sendVideoFile, not the
    // shared JSON callApi() path every other method here uses. Real hard
    // ceiling: 50MB -- Telegram's own, not LazyRelay's, and not liftable by
    // raising LazyRelay's app-wide cap (enforced pre-flight by
    // mediaLimits.ts).
    if (isVideo) {
      const res = await this.sendVideoFile(botToken, chatId, request.mediaUrl!, request.content);
      if (!res.ok || !res.result) {
        return { success: false, platformPostId: null, errorMessage: res.description ?? "Telegram sendVideo failed" };
      }
      return { success: true, platformPostId: String(res.result.message_id), errorMessage: null };
    }

    const method = request.mediaUrl ? "sendPhoto" : "sendMessage";
    const params: Record<string, string> = request.mediaUrl
      ? { chat_id: chatId, photo: request.mediaUrl, caption: request.content }
      : { chat_id: chatId, text: request.content };

    const res = await this.callApi<TelegramMessage>(botToken, method, params);
    if (!res.ok || !res.result) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: res.description ?? `Telegram ${method} failed`,
      };
    }

    return { success: true, platformPostId: String(res.result.message_id), errorMessage: null };
  }

  // Real, documented Telegram Bot API limitation: there is no endpoint to
  // fetch an arbitrary message back by id, so "did it actually go live"
  // can't be checked the direct way every other adapter uses. getChat
  // confirms the channel is still reachable and public-URL-able -- a
  // per-message copyMessage probe (the old global-log-chat approach) was
  // dropped in the 2026-09-08 redesign since there's no longer a single
  // shared log chat every customer's bot can reach; a customer-specific
  // log chat would need its own connect-flow field, not built here.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const { botToken, chatId } = parseCredentials(accessToken);

    const chatRes = await this.callApi<TelegramChat>(botToken, "getChat", { chat_id: chatId });
    if (!chatRes.ok || !chatRes.result) {
      return {
        verifiedLive: false,
        platformPostUrl: null,
        errorMessage: chatRes.description ?? "Telegram channel is no longer reachable (bot may have been removed as admin)",
      };
    }
    const chat = chatRes.result;
    const platformPostUrl = chat.username ? `https://t.me/${chat.username}/${platformPostId}` : null;

    return {
      verifiedLive: false,
      platformPostUrl,
      errorMessage: "Channel is reachable, but Telegram's Bot API has no get-message-by-id endpoint, so a specific message's existence can't be independently confirmed",
    };
  }

  // Telegram has no REST "list comments on this post" endpoint -- replies
  // to a channel post live in that channel's linked discussion group, and
  // the only way to see them is the bot's own update stream (getUpdates).
  // Each customer's bot only ever receives updates for chats it's been
  // added to, so -- unlike the old shared-bot model -- there's no
  // cross-customer routing problem here: whatever this call returns
  // already belongs to this one customer. Deliberately non-destructive
  // (no offset passed), so Telegram keeps redelivering the same updates
  // until they age out of its ~24h buffer -- the poller upserts on
  // platform_comment_id, so re-seeing one is harmless, and this avoids
  // needing a new persisted per-bot cursor for a first pass.
  async getComments(platformPostId: string, accessToken: string): Promise<CommentsResult> {
    const { botToken, chatId } = parseCredentials(accessToken);

    const chatRes = await this.callApi<TelegramChat>(botToken, "getChat", { chat_id: chatId });
    if (!chatRes.ok || !chatRes.result) {
      return { comments: [], errorMessage: chatRes.description ?? "Telegram channel is no longer reachable" };
    }
    const linkedChatId = chatRes.result.linked_chat_id;
    if (!linkedChatId) {
      // Genuinely common, not an error -- most channels never enable
      // Discussion. Honest empty result rather than a scary error message.
      return { comments: [], errorMessage: null };
    }

    const updatesRes = await this.callApi<TelegramUpdate[]>(botToken, "getUpdates", { limit: "100" });
    if (!updatesRes.ok || !updatesRes.result) {
      return { comments: [], errorMessage: updatesRes.description ?? "Could not read Telegram updates" };
    }

    // A reply to a channel post shows up in the linked discussion group as
    // a message whose reply_to_message is the auto-forwarded copy of that
    // channel post -- forward_from_message_id on that forwarded copy is
    // the original channel post's message_id, which is what platformPostId
    // actually is (matches the id post() returns).
    const targetId = Number(platformPostId);
    const comments = updatesRes.result.flatMap((u) => {
      const m = u.message;
      if (!m || String(m.chat.id) !== String(linkedChatId)) return [];
      if (m.reply_to_message?.forward_from_message_id !== targetId) return [];
      const text = m.text ?? m.caption ?? "";
      if (!text) return [];
      return [
        {
          id: String(m.message_id),
          author: m.from?.username ?? m.from?.first_name ?? "Unknown",
          text,
          url: null,
          createdAt: new Date(m.date * 1000).toISOString(),
        },
      ];
    });
    return { comments, errorMessage: null };
  }

  async replyToComment(commentId: string, text: string, accessToken: string): Promise<CommentPostResult> {
    const { botToken, chatId } = parseCredentials(accessToken);
    const chatRes = await this.callApi<TelegramChat>(botToken, "getChat", { chat_id: chatId });
    const linkedChatId = chatRes.result?.linked_chat_id;
    if (!chatRes.ok || !linkedChatId) {
      return { success: false, errorMessage: chatRes.description ?? "This channel has no linked discussion group to reply into" };
    }

    const res = await this.callApi<TelegramMessage>(botToken, "sendMessage", {
      chat_id: String(linkedChatId),
      text,
      reply_to_message_id: commentId,
    });
    if (!res.ok || !res.result) {
      return { success: false, errorMessage: res.description ?? "Telegram reply failed" };
    }
    return { success: true, errorMessage: null };
  }

  // DMs = private messages sent directly to this customer's own bot.
  // Same non-destructive getUpdates read as getComments, filtered to
  // chat.type === "private" instead of the linked discussion group.
  async getConversations(accessToken: string): Promise<DMConversationsResult> {
    const { botToken } = parseCredentials(accessToken);

    const updatesRes = await this.callApi<TelegramUpdate[]>(botToken, "getUpdates", { limit: "100" });
    if (!updatesRes.ok || !updatesRes.result) {
      return { conversations: [], errorMessage: updatesRes.description ?? "Could not read Telegram updates" };
    }

    // Collapse to the latest private message per sender -- getUpdates
    // returns a flat event stream, not conversations, so this reduces it
    // to one row per chat the way every other platform's inbox works.
    const latestByChat = new Map<number, TelegramUpdateMessage>();
    for (const u of updatesRes.result) {
      const m = u.message;
      if (!m || m.chat.type !== "private") continue;
      const existing = latestByChat.get(m.chat.id);
      if (!existing || m.date > existing.date) latestByChat.set(m.chat.id, m);
    }

    const conversations = Array.from(latestByChat.values()).map((m) => ({
      id: String(m.chat.id),
      participantId: String(m.from?.id ?? m.chat.id),
      participantName: m.from?.username ?? m.from?.first_name ?? "Unknown",
      snippet: m.text ?? m.caption ?? null,
      updatedAt: new Date(m.date * 1000).toISOString(),
    }));
    return { conversations, errorMessage: null };
  }

  // conversationId is the private chat_id from getConversations above.
  // Same non-destructive getUpdates read, filtered to every message in
  // that one chat rather than collapsed to the latest.
  async getDirectMessages(conversationId: string, accessToken: string): Promise<DMMessagesResult> {
    const { botToken } = parseCredentials(accessToken);

    const updatesRes = await this.callApi<TelegramUpdate[]>(botToken, "getUpdates", { limit: "100" });
    if (!updatesRes.ok || !updatesRes.result) {
      return { messages: [], errorMessage: updatesRes.description ?? "Could not read Telegram updates" };
    }

    const messages = updatesRes.result.flatMap((u) => {
      const m = u.message;
      if (!m || m.chat.type !== "private" || String(m.chat.id) !== conversationId) return [];
      const text = m.text ?? m.caption ?? "";
      if (!text) return [];
      return [
        {
          id: String(m.message_id),
          fromId: String(m.from?.id ?? m.chat.id),
          fromName: m.from?.username ?? m.from?.first_name ?? "Unknown",
          text,
          createdAt: new Date(m.date * 1000).toISOString(),
        },
      ];
    });
    return { messages, errorMessage: null };
  }

  async sendDirectMessage(recipientId: string, text: string, accessToken: string): Promise<SendDMResult> {
    const { botToken } = parseCredentials(accessToken);
    const res = await this.callApi<TelegramMessage>(botToken, "sendMessage", { chat_id: recipientId, text });
    if (!res.ok || !res.result) {
      return { success: false, errorMessage: res.description ?? "Telegram DM failed" };
    }
    return { success: true, errorMessage: null };
  }
}
