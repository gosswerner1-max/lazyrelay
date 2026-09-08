import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
  CommentsResult,
  CommentPostResult,
} from "./types.js";
import { fetchMediaForStreaming, buildStreamingMultipartBody, type RequestInitWithDuplex } from "./streamUpload.js";

const DISCORD_API = "https://discord.com/api/v10";

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v|webm)(\?.*)?$/i.test(url);
}

interface DiscordCredentials {
  webhookUrl: string;
  channelId: string;
}

function parseCredentials(accessToken: string): DiscordCredentials {
  // Pre-2026-09-08 accounts stored the bare webhook URL string, not JSON —
  // channelId simply wasn't known yet at connect time. Handled as a
  // distinct case (not a parse failure) so existing customers don't need
  // to reconnect just to keep posting; they only lose reply/comment
  // capability until they add the bot (see DiscordAdapter's class comment)
  // and reconnect to pick up a channelId.
  if (accessToken.startsWith("https://")) {
    return { webhookUrl: accessToken, channelId: "" };
  }
  try {
    const parsed = JSON.parse(accessToken) as Partial<DiscordCredentials>;
    if (!parsed.webhookUrl) throw new Error("missing field");
    return { webhookUrl: parsed.webhookUrl, channelId: parsed.channelId ?? "" };
  } catch {
    throw new Error("Corrupt Discord credentials — reconnect this account");
  }
}

// Posting: a channel webhook URL, not OAuth — a customer creates one in
// their own server (Channel Settings -> Integrations -> Webhooks -> New
// Webhook -> Copy Webhook URL) and pastes it into LazyRelay's connect
// page. Same non-OAuth "connect page collects a credential, resubmits as
// JSON code" shape as BlueskyAdapter/TelegramAdapter. Unaffected by the
// 2026-09-08 addition below -- existing customers keep posting exactly as
// before.
//
// Reply/comments (added 2026-09-08): a webhook is write-only -- it cannot
// read a channel's messages at all, so replying needed a real bot
// instead. Unlike Telegram, Discord's own convention is ONE shared bot
// application installed into every customer's server (not a
// per-customer bot) -- that's how every Discord bot service works, and
// Discord's own permission model already scopes what the bot can see to
// only the servers it's been invited into, so there's no cross-customer
// routing ambiguity the way the old Telegram design had. The customer
// invites LazyRelay's bot via the invite link on the connect page
// (DISCORD_BOT_INVITE_URL in ConnectForm.tsx, built from the same
// DISCORD_BOT_PERMISSIONS below), then reconnects so the webhook's own
// channel_id (already returned by Discord, see exchangeCode) gets stored
// alongside it.
//
// DMs deliberately NOT built here. Discord's REST API has no way to
// list/poll for new direct messages the way Telegram's getUpdates or a
// simple "list conversations" endpoint does -- a bot only learns about a
// DM at all through the Gateway (a persistent WebSocket connection), which
// this codebase's poll-on-a-schedule architecture (mentionsAndDmsPoller.ts)
// isn't built for. That's a real, separate infrastructure piece (a
// long-running Gateway listener process, not a request/response
// function), not a small addition -- flagged in the vault rather than
// half-built or faked here.
export const DISCORD_BOT_PERMISSIONS = "68608"; // View Channels + Send Messages + Read Message History

export class DiscordAdapter implements PlatformAdapter {
  readonly platform: "discord" = "discord";

  constructor(
    private readonly connectPageUrl: string,
    private readonly botToken?: string,
  ) {}

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({ state });
    return `${this.connectPageUrl}?${params.toString()}`;
  }

  // `code` here is a JSON string `{"webhookUrl":"https://discord.com/api/webhooks/{id}/{token}"}`.
  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    let webhookUrl: string;
    try {
      const parsed = JSON.parse(code) as { webhookUrl?: string };
      if (!parsed.webhookUrl) throw new Error("missing field");
      webhookUrl = parsed.webhookUrl;
    } catch {
      throw new Error("Discord connect requires a channel webhook URL");
    }

    if (!/^https:\/\/discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(webhookUrl)) {
      throw new Error("That doesn't look like a valid Discord webhook URL");
    }

    // Validate the webhook is real and alive before storing it — a GET on
    // the webhook URL itself (no token needed beyond what's in the URL)
    // returns the webhook's own metadata.
    const res = await fetch(webhookUrl);
    const json = (await res.json()) as {
      id?: string;
      name?: string;
      channel_id?: string;
      guild_id?: string;
      message?: string;
    };
    if (!res.ok || !json.id) {
      throw new Error(json.message ?? `Could not verify that Discord webhook (HTTP ${res.status})`);
    }

    // accessToken is now JSON (webhookUrl + channelId) rather than the bare
    // webhook URL string, so replyToComment/getComments -- which need the
    // channel id, not just the write-only webhook -- have what they need.
    // channel_id comes straight from the webhook's own metadata above, no
    // extra step for the customer.
    return {
      accessToken: JSON.stringify({ webhookUrl, channelId: json.channel_id ?? "" } satisfies DiscordCredentials),
      refreshToken: null,
      expiresAt: null,
      platformAccountId: json.id,
      displayName: json.name ?? "Discord Webhook",
    };
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const { webhookUrl } = parseCredentials(request.accessToken);
    const params = new URLSearchParams({ wait: "true" });

    // Video support added 2026-09-05 (confirmed live via Discord's own
    // current docs): unlike images, Discord will NOT inline-render a remote
    // video URL through an embed -- it must be a genuine attachment, sent
    // as real multipart/form-data with a `files[n]` binary part alongside a
    // `payload_json` field carrying the rest of the body. Streamed rather
    // than buffered (see streamUpload.ts). Real ceiling is NOT one number:
    // it depends on the destination server's own boost tier (20MB
    // unboosted, up to 100MB at max boost) -- something this adapter has no
    // way to know in advance from just a webhook URL, so mediaLimits.ts
    // uses a conservative default rather than a real per-server check.
    if (request.mediaUrl && isVideoUrl(request.mediaUrl)) {
      const media = await fetchMediaForStreaming(request.mediaUrl);
      if (!media) {
        return { success: false, platformPostId: null, errorMessage: `Could not fetch video from ${request.mediaUrl}` };
      }
      const { body, contentType, contentLength } = buildStreamingMultipartBody([
        {
          fieldName: "payload_json",
          value: JSON.stringify({ content: request.content, attachments: [{ id: 0, filename: "video.mp4" }] }),
        },
        { fieldName: "files[0]", value: { filename: "video.mp4", contentType: media.contentType, data: media.body, sizeBytes: media.sizeBytes } },
      ]);
      // Content-Length set whenever known -- some upload endpoints reject a
      // chunked-transfer body outright (confirmed on Pinterest's S3-style
      // upload, HTTP 411); passing sizeBytes above lets it be computed
      // without buffering the file (see buildStreamingMultipartBody).
      const res = await fetch(`${webhookUrl}?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": contentType, ...(contentLength != null ? { "Content-Length": String(contentLength) } : {}) },
        body,
        duplex: "half",
      } as RequestInitWithDuplex);
      const json = (await res.json()) as { id?: string; message?: string };
      if (!res.ok || !json.id) {
        return { success: false, platformPostId: null, errorMessage: json.message ?? `Discord video post failed (HTTP ${res.status})` };
      }
      return { success: true, platformPostId: json.id, errorMessage: null };
    }

    const body: { content: string; embeds?: Array<{ image: { url: string } }> } = {
      content: request.content,
    };
    if (request.mediaUrl) {
      body.embeds = [{ image: { url: request.mediaUrl } }];
    }

    const res = await fetch(`${webhookUrl}?${params.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      id?: string;
      channel_id?: string;
      message?: string;
    };

    if (!res.ok || !json.id) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: json.message ?? `Discord post failed (HTTP ${res.status})`,
      };
    }

    return { success: true, platformPostId: json.id, errorMessage: null };
  }

  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const { webhookUrl } = parseCredentials(accessToken);
    const messagesUrl = `${webhookUrl}/messages/${platformPostId}`;
    const res = await fetch(messagesUrl);
    const json = (await res.json()) as {
      id?: string;
      channel_id?: string;
      message?: string;
    };

    if (!res.ok || !json.id) {
      return {
        verifiedLive: false,
        platformPostUrl: null,
        errorMessage: json.message ?? `Discord message could not be independently confirmed (HTTP ${res.status})`,
      };
    }

    // Building a real jump-to-message link needs the guild id, which
    // isn't in the message payload — a second lookup on the webhook
    // itself provides it.
    let guildId: string | null = null;
    try {
      const webhookRes = await fetch(webhookUrl);
      const webhookJson = (await webhookRes.json()) as { guild_id?: string };
      guildId = webhookJson.guild_id ?? null;
    } catch {
      // Non-fatal — see comment above.
    }

    return {
      verifiedLive: true,
      platformPostUrl: guildId
        ? `https://discord.com/channels/${guildId}/${json.channel_id}/${json.id}`
        : null,
      errorMessage: null,
    };
  }

  // Uses the shared bot token (see class comment) against Discord's real
  // channel-messages REST endpoint -- unlike DMs, this needs no Gateway
  // connection, a normal GET/POST works. platformPostId is the message id
  // post() already returns; commentId for replyToComment is a message id
  // from getComments below. Both silently no-op (empty/failed, not a
  // thrown error) when this account was connected before 2026-09-08 and
  // has no channelId yet, or when the bot token isn't configured.
  async getComments(platformPostId: string, accessToken: string): Promise<CommentsResult> {
    if (!this.botToken) return { comments: [], errorMessage: null };
    const { channelId } = parseCredentials(accessToken);
    if (!channelId) {
      return { comments: [], errorMessage: "This account was connected before reply support existed — reconnect it to enable replies." };
    }

    // `after` = the post itself, so this only returns messages that came
    // after it (real replies), not the whole channel's history.
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages?after=${platformPostId}&limit=100`, {
      headers: { Authorization: `Bot ${this.botToken}` },
    });
    const json = (await res.json()) as Array<{ id: string; content: string; author?: { username?: string }; timestamp?: string }> | { message?: string };
    if (!res.ok || !Array.isArray(json)) {
      const err = Array.isArray(json) ? null : json.message;
      return { comments: [], errorMessage: err ?? `Could not load Discord messages (HTTP ${res.status}) — make sure the bot has been invited to this server` };
    }

    const comments = json
      .filter((m) => m.content)
      .map((m) => ({
        id: m.id,
        author: m.author?.username ?? "Unknown",
        text: m.content,
        url: null,
        createdAt: m.timestamp ?? null,
      }));
    return { comments, errorMessage: null };
  }

  async replyToComment(commentId: string, text: string, accessToken: string): Promise<CommentPostResult> {
    if (!this.botToken) return { success: false, errorMessage: "Discord bot is not configured" };
    const { channelId } = parseCredentials(accessToken);
    if (!channelId) {
      return { success: false, errorMessage: "This account was connected before reply support existed — reconnect it to enable replies." };
    }

    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${this.botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, message_reference: { message_id: commentId } }),
    });
    const json = (await res.json()) as { id?: string; message?: string };
    if (!res.ok || !json.id) {
      return { success: false, errorMessage: json.message ?? `Discord reply failed (HTTP ${res.status}) — make sure the bot has been invited to this server` };
    }
    return { success: true, errorMessage: null };
  }
}
