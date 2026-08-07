import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
  CommentsResult,
  PostMetrics,
} from "./types.js";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const UPLOAD_INIT_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
const COMMENT_THREADS_URL = "https://www.googleapis.com/youtube/v3/commentThreads";

// youtube.upload lets us post videos; youtube.readonly lets us look up the
// authenticated channel's id/title for OAuthExchangeResult.
const SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";

// People & Blogs — a real, valid YouTube category id. PostRequest has no
// category field, so this is a fixed default rather than a per-post choice.
const DEFAULT_CATEGORY_ID = "22";

// A fresh upload's real processing time exceeded even a 60s window in
// production (confirmed 2026-08-04: a real customer-facing upload showed
// "still processing — verification timed out" in the UI, then was
// independently confirmed live and Public on YouTube's own side minutes
// later — a false-negative, not an actual failure). YouTube's own docs
// don't guarantee a processing SLA, so 30 attempts x 10s gives 5 minutes of
// real headroom before this gives up and lets the scheduler's own
// MAX_RETRIES=3 backoff-retry (scheduler.ts) take over for anything still
// not done after that.
const STATUS_POLL_ATTEMPTS = 30;
const STATUS_POLL_DELAY_MS = 10000;

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
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

interface YouTubeErrorBody {
  error?: { message?: string };
}

interface YouTubeCommentThreadListResponse {
  items?: Array<{
    id?: string;
    snippet?: {
      topLevelComment?: {
        snippet?: { authorDisplayName?: string; textDisplay?: string; publishedAt?: string };
      };
    };
  }>;
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

  async getComments(platformPostId: string, accessToken: string): Promise<CommentsResult> {
    const url = new URL(COMMENT_THREADS_URL);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("videoId", platformPostId);
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("order", "time");

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const json = (await res.json().catch(() => ({}))) as YouTubeCommentThreadListResponse & YouTubeErrorBody;
    if (!res.ok) {
      // Comments disabled on the video is a real, common, non-error case —
      // YouTube returns 403 commentsDisabled for it, not an empty list.
      return { comments: [], errorMessage: json.error?.message ?? `Could not load comments (HTTP ${res.status})` };
    }

    const comments = (json.items ?? []).flatMap((item) => {
      const c = item.snippet?.topLevelComment?.snippet;
      if (!item.id || !c) return [];
      return [
        {
          id: item.id,
          author: c.authorDisplayName ?? "Unknown",
          text: c.textDisplay ?? "",
          url: `https://www.youtube.com/watch?v=${platformPostId}&lc=${item.id}`,
          createdAt: c.publishedAt ?? null,
        },
      ];
    });
    return { comments, errorMessage: null };
  }

  // Same VIDEOS_URL as verifyPublished, different `part`. YouTube returns
  // statistics fields as strings, not numbers — parsed explicitly rather
  // than left as-is, since a stringified count would silently break any
  // arithmetic done on it downstream (sums, growth-curve math).
  async getPostMetrics(platformPostId: string, accessToken: string): Promise<PostMetrics> {
    const res = await fetch(`${VIDEOS_URL}?part=statistics&id=${platformPostId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json().catch(() => ({}))) as { items?: YouTubeVideoResource[] } & YouTubeErrorBody;

    if (!res.ok) {
      return {
        likes: null,
        comments: null,
        shares: null,
        views: null,
        errorMessage: json.error?.message ?? `Could not load metrics (HTTP ${res.status})`,
      };
    }
    const stats = json.items?.[0]?.statistics;
    if (!stats) {
      return { likes: null, comments: null, shares: null, views: null, errorMessage: "YouTube video not found" };
    }

    const toNumber = (s: string | undefined): number | null => (s === undefined ? null : Number(s));
    return {
      likes: toNumber(stats.likeCount),
      comments: toNumber(stats.commentCount),
      shares: null, // YouTube doesn't expose a share count via the Data API
      views: toNumber(stats.viewCount),
      errorMessage: null,
    };
  }
}
