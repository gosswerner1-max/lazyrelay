import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
} from "./types.js";

// Real, confirmed architectural gap: Telegram has no OAuth "authorize this
// app" flow at all for channels — bots are created once via BotFather and
// the resulting token authenticates as the bot itself, not per-connected-
// customer. The real-world pattern used by every Telegram-supporting
// scheduler (confirmed via their own docs, since Telegram's own docs don't
// cover third-party product integration): LazyRelay runs ONE shared bot
// (@lazyrelay_bot); a customer manually adds that bot as an Administrator
// with "Post Messages" rights to their own channel, then tells LazyRelay
// which channel via its @username. There's no secret exchanged per
// customer — the "access token" this adapter stores per connected account
// is really just the channel's numeric chat id (stable even if the
// @username changes later), not a credential. getAuthorizeUrl() points at
// a LazyRelay-hosted connect page (not built yet — same acknowledged gap
// as Bluesky's) that collects that @username and resubmits it as the
// generic callback's "code".
const API_BASE = "https://api.telegram.org";

interface TelegramChat {
  id: number;
  title?: string;
  username?: string;
  type?: string;
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

export class TelegramAdapter implements PlatformAdapter {
  readonly platform: "telegram" = "telegram";

  // botToken authenticates every API call as @lazyrelay_bot itself — the
  // one secret this whole adapter needs, shared across all customers.
  // connectPageUrl mirrors Bluesky's not-yet-built connect-form pattern.
  // logChatId is optional: a private chat the bot can copyMessage into for
  // real per-message Proof-of-Publish verification (see verifyPublished
  // below for why this matters) — Telegram's Bot API has no GET-by-
  // message-id endpoint, confirmed live, so without a configured log chat
  // this adapter is honest about only being able to confirm the *channel*
  // is still reachable, not that a specific message still exists.
  constructor(
    private readonly botToken: string,
    private readonly connectPageUrl: string,
    private readonly logChatId?: string,
  ) {}

  private async callApi<T>(method: string, params: Record<string, string>): Promise<TelegramApiResponse<T>> {
    const res = await fetch(`${API_BASE}/bot${this.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    return (await res.json()) as TelegramApiResponse<T>;
  }

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({ state });
    return `${this.connectPageUrl}?${params.toString()}`;
  }

  // `code` here is a JSON string `{"channelUsername":"@mychannel"}` — see
  // the class-level comment for why there's no real OAuth code to exchange.
  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    let channelUsername: string;
    try {
      const parsed = JSON.parse(code) as { channelUsername?: string };
      if (!parsed.channelUsername) throw new Error("missing field");
      channelUsername = parsed.channelUsername;
    } catch {
      throw new Error("Telegram connect requires the channel's @username");
    }

    const chatRes = await this.callApi<TelegramChat>("getChat", { chat_id: channelUsername });
    if (!chatRes.ok || !chatRes.result) {
      throw new Error(chatRes.description ?? "Could not find that Telegram channel — make sure the @username is correct and public");
    }
    const chat = chatRes.result;

    const meRes = await this.callApi<TelegramUser>("getMe", {});
    if (!meRes.ok || !meRes.result) {
      throw new Error(meRes.description ?? "Could not identify the LazyRelay bot");
    }

    const memberRes = await this.callApi<TelegramChatMember>("getChatMember", {
      chat_id: channelUsername,
      user_id: String(meRes.result.id),
    });
    const member = memberRes.result;
    if (!memberRes.ok || !member || member.status !== "administrator" || member.can_post_messages !== true) {
      throw new Error("@lazyrelay_bot must be added as an Administrator with \"Post Messages\" permission on this channel before connecting it");
    }

    return {
      accessToken: String(chat.id),
      refreshToken: null,
      // Bot admin rights don't expire on a timer the way OAuth tokens do —
      // they last until the customer removes the bot from the channel.
      expiresAt: null,
      platformAccountId: String(chat.id),
      displayName: chat.title ?? chat.username ?? channelUsername,
    };
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const chatId = request.accessToken;

    if (request.mediaUrl && /\.(mp4|mov|m4v|webm)(\?.*)?$/i.test(request.mediaUrl)) {
      // sendVideo exists on Telegram's real API but isn't implemented here
      // yet — honest failure rather than a half-built video path, same
      // shape as Pinterest's/Bluesky's video gaps.
      return {
        success: false,
        platformPostId: null,
        errorMessage: "Telegram video posts are not yet supported by this adapter",
      };
    }

    const method = request.mediaUrl ? "sendPhoto" : "sendMessage";
    const params: Record<string, string> = request.mediaUrl
      ? { chat_id: chatId, photo: request.mediaUrl, caption: request.content }
      : { chat_id: chatId, text: request.content };

    const res = await this.callApi<TelegramMessage>(method, params);
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
  // can't be checked the direct way every other adapter uses. This does
  // the best real verification available: (1) getChat confirms the
  // channel is still reachable and public-URL-able, and (2) if a log chat
  // is configured, copyMessage into it is a genuine existence probe for
  // that specific message_id (it only succeeds if the message still
  // exists). Without a log chat configured, this honestly reports
  // verifiedLive:false rather than faking confidence it doesn't have —
  // per the Proof-of-Publish discipline this whole interface exists for.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const chatId = accessToken;

    const chatRes = await this.callApi<TelegramChat>("getChat", { chat_id: chatId });
    if (!chatRes.ok || !chatRes.result) {
      return {
        verifiedLive: false,
        platformPostUrl: null,
        errorMessage: chatRes.description ?? "Telegram channel is no longer reachable (bot may have been removed as admin)",
      };
    }
    const chat = chatRes.result;
    const platformPostUrl = chat.username ? `https://t.me/${chat.username}/${platformPostId}` : null;

    if (!this.logChatId) {
      return {
        verifiedLive: false,
        platformPostUrl,
        errorMessage: "Channel is reachable, but independent per-message verification requires TELEGRAM_LOG_CHAT_ID to be configured (Telegram's Bot API has no get-message-by-id endpoint)",
      };
    }

    const copyRes = await this.callApi<TelegramMessage>("copyMessage", {
      chat_id: this.logChatId,
      from_chat_id: chatId,
      message_id: platformPostId,
    });

    if (!copyRes.ok || !copyRes.result) {
      return {
        verifiedLive: false,
        platformPostUrl,
        errorMessage: copyRes.description ?? "Message could not be independently confirmed live",
      };
    }

    return { verifiedLive: true, platformPostUrl, errorMessage: null };
  }
}
