import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
} from "./types.js";
import { fetchMediaForStreaming, buildStreamingMultipartBody, type RequestInitWithDuplex } from "./streamUpload.js";

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v|webm)(\?.*)?$/i.test(url);
}

// Discord posting uses a channel webhook URL, not OAuth — a customer
// creates one in their own server (Channel Settings -> Integrations ->
// Webhooks -> New Webhook -> Copy Webhook URL) and pastes it into
// LazyRelay's connect page. Same non-OAuth "connect page collects a
// credential, resubmits as JSON code" shape as BlueskyAdapter/
// TelegramAdapter — no developer app registration needed at all for this
// platform.
export class DiscordAdapter implements PlatformAdapter {
  readonly platform: "discord" = "discord";

  constructor(private readonly connectPageUrl: string) {}

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

    // The webhook URL itself IS the "access token" — it's a single opaque
    // bearer credential, same shape as every other adapter's accessToken.
    return {
      accessToken: webhookUrl,
      refreshToken: null,
      expiresAt: null,
      platformAccountId: json.id,
      displayName: json.name ?? "Discord Webhook",
    };
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
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
      const res = await fetch(`${request.accessToken}?${params.toString()}`, {
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

    const res = await fetch(`${request.accessToken}?${params.toString()}`, {
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
    const messagesUrl = `${accessToken}/messages/${platformPostId}`;
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
      const webhookRes = await fetch(accessToken);
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
}
