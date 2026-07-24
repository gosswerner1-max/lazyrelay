import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
} from "./types.js";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const UPLOAD_INIT_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

// youtube.upload lets us post videos; youtube.readonly lets us look up the
// authenticated channel's id/title for OAuthExchangeResult.
const SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";

// People & Blogs — a real, valid YouTube category id. PostRequest has no
// category field, so this is a fixed default rather than a per-post choice.
const DEFAULT_CATEGORY_ID = "22";

// A fresh upload's real processing time exceeded a 15s window in testing
// (post() succeeded immediately, but verifyPublished() needed longer to see
// "processed") — 10 attempts x 6s gives a minute of real headroom.
const STATUS_POLL_ATTEMPTS = 10;
const STATUS_POLL_DELAY_MS = 6000;

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface YouTubeChannelListResponse {
  items?: Array<{ id?: string; snippet?: { title?: string } }>;
}

interface YouTubeVideoResource {
  id?: string;
  status?: { uploadStatus?: string; privacyStatus?: string };
  processingDetails?: { processingStatus?: string };
}

interface YouTubeErrorBody {
  error?: { message?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class YouTubeAdapter implements PlatformAdapter {
  readonly platform: "youtube" = "youtube";

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: this.redirectUri,
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await res.json()) as GoogleTokenResponse;

    if (!res.ok || !json.access_token) {
      throw new Error(json.error_description ?? json.error ?? "Google token exchange failed");
    }

    // Best-effort channel lookup — a failure here shouldn't block the
    // connect flow (mirrors TikTokAdapter's non-fatal display-name lookup).
    let displayName: string | null = null;
    let platformAccountId = "unknown";
    try {
      const channelRes = await fetch(`${CHANNELS_URL}?part=snippet&mine=true`, {
        headers: { Authorization: `Bearer ${json.access_token}` },
      });
      const channelJson = (await channelRes.json()) as YouTubeChannelListResponse;
      const channel = channelJson.items?.[0];
      if (channel?.id) {
        platformAccountId = channel.id;
        displayName = channel.snippet?.title ?? null;
      }
    } catch {
      // Non-fatal — see comment above.
    }

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
      platformAccountId,
      displayName,
    };
  }

  // YouTube's resumable upload is a two-step, client-driven transfer (not a
  // pull_by_url like TikTok's) — LazyRelay must fetch the video bytes itself
  // and push them to the session URL Google hands back.
  async post(request: PostRequest): Promise<PostAttemptResult> {
    if (!request.mediaUrl) {
      return { success: false, platformPostId: null, errorMessage: "YouTube posts require a video URL" };
    }

    const initRes = await fetch(UPLOAD_INIT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        snippet: {
          title: request.content.slice(0, 100) || "LazyRelay post",
          description: request.content.slice(0, 5000),
          categoryId: DEFAULT_CATEGORY_ID,
        },
        status: {
          privacyStatus: "public",
        },
      }),
    });
    if (!initRes.ok) {
      const errJson = (await initRes.json().catch(() => ({}))) as YouTubeErrorBody;
      return {
        success: false,
        platformPostId: null,
        errorMessage: errJson.error?.message ?? `YouTube upload init failed (HTTP ${initRes.status})`,
      };
    }
    const uploadUrl = initRes.headers.get("location");
    if (!uploadUrl) {
      return { success: false, platformPostId: null, errorMessage: "YouTube did not return a resumable upload URL" };
    }

    const videoRes = await fetch(request.mediaUrl);
    if (!videoRes.ok || !videoRes.body) {
      return { success: false, platformPostId: null, errorMessage: `Could not fetch video from ${request.mediaUrl}` };
    }
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
    const contentType = videoRes.headers.get("content-type")?.startsWith("video/")
      ? videoRes.headers.get("content-type")!
      : "video/mp4";

    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(videoBuffer.byteLength),
      },
      body: videoBuffer,
    });
    const uploadJson = (await uploadRes.json().catch(() => ({}))) as YouTubeVideoResource & YouTubeErrorBody;

    if (!uploadRes.ok || !uploadJson.id) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: uploadJson.error?.message ?? `YouTube video upload failed (HTTP ${uploadRes.status})`,
      };
    }

    return { success: true, platformPostId: uploadJson.id, errorMessage: null };
  }

  // Newly uploaded videos process asynchronously — poll videos.list for a
  // bounded window rather than trusting post()'s success alone, per the
  // Proof-of-Publish discipline this whole interface exists for.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt++) {
      const res = await fetch(`${VIDEOS_URL}?part=status,processingDetails&id=${platformPostId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const json = (await res.json().catch(() => ({}))) as { items?: YouTubeVideoResource[] } & YouTubeErrorBody;

      if (!res.ok) {
        return {
          verifiedLive: false,
          platformPostUrl: null,
          errorMessage: json.error?.message ?? `YouTube status check failed (HTTP ${res.status})`,
        };
      }
      const video = json.items?.[0];
      if (!video) {
        return { verifiedLive: false, platformPostUrl: null, errorMessage: "YouTube video not found" };
      }

      const processingStatus = video.processingDetails?.processingStatus;
      const uploadStatus = video.status?.uploadStatus;
      if (uploadStatus === "processed" || processingStatus === "succeeded") {
        return {
          verifiedLive: true,
          platformPostUrl: `https://www.youtube.com/watch?v=${platformPostId}`,
          errorMessage: null,
        };
      }
      if (uploadStatus === "rejected" || uploadStatus === "failed") {
        return { verifiedLive: false, platformPostUrl: null, errorMessage: `YouTube reported upload status: ${uploadStatus}` };
      }

      if (attempt < STATUS_POLL_ATTEMPTS - 1) await sleep(STATUS_POLL_DELAY_MS);
    }

    return {
      verifiedLive: false,
      platformPostUrl: null,
      errorMessage: "YouTube is still processing this video — verification timed out",
    };
  }
}
