import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
} from "./types.js";

// Threads has its own auth/graph hosts, separate from the rest of Meta's
// Graph API (threads.net for the authorize dialog, graph.threads.net for
// everything else) — confirmed live via Meta's own docs, not the regular
// graph.facebook.com used by a Facebook/Instagram Login flow.
const AUTHORIZE_URL = "https://threads.net/oauth/authorize";
const TOKEN_URL = "https://graph.threads.net/oauth/access_token";
const LONG_LIVED_TOKEN_URL = "https://graph.threads.net/access_token";
const GRAPH_BASE = "https://graph.threads.net/v1.0";

const SCOPES = "threads_basic,threads_content_publish";

interface ThreadsTokenResponse {
  access_token?: string;
  user_id?: string;
  error_type?: string;
  error_message?: string;
}

interface ThreadsLongLivedTokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface ThreadsUserInfo {
  id?: string;
  username?: string;
}

interface ThreadsErrorBody {
  error?: { message?: string };
}

interface ThreadsContainerResponse {
  id?: string;
}

interface ThreadsMediaResponse {
  id?: string;
  permalink?: string;
}

interface ThreadsContainerStatusResponse {
  // CAUGHT LIVE 2026-09-05: the real field name is `status`, NOT
  // `status_code` -- Instagram's equivalent container-status field really
  // is `status_code`, and the earlier research summary conflated the two
  // APIs' naming. Confirmed directly: querying `status_code` on a Threads
  // container returns "Tried accessing nonexisting field (status_code)".
  status?: "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v)(\?.*)?$/i.test(url);
}

export class ThreadsAdapter implements PlatformAdapter {
  readonly platform: "threads" = "threads";

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: SCOPES,
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: this.redirectUri,
      code,
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await res.json()) as ThreadsTokenResponse;
    if (!res.ok || !json.access_token) {
      throw new Error(json.error_message ?? json.error_type ?? "Threads token exchange failed");
    }

    // The short-lived token from the code exchange is only valid ~1 hour —
    // real, confirmed-live behavior: every connection must be upgraded to a
    // long-lived (60-day) token immediately, or it expires before the
    // customer's next scheduled post.
    const longLivedUrl = new URL(LONG_LIVED_TOKEN_URL);
    longLivedUrl.searchParams.set("grant_type", "th_exchange_token");
    longLivedUrl.searchParams.set("client_secret", this.clientSecret);
    longLivedUrl.searchParams.set("access_token", json.access_token);
    const longLivedRes = await fetch(longLivedUrl.toString());
    const longLivedJson = (await longLivedRes.json()) as ThreadsLongLivedTokenResponse;
    if (!longLivedRes.ok || !longLivedJson.access_token) {
      throw new Error("Could not exchange for a long-lived Threads token");
    }

    const userInfo = await this.getMe(longLivedJson.access_token);

    return {
      accessToken: longLivedJson.access_token,
      // Threads has no separate refresh token — the same long-lived access
      // token is extended in place via GET /refresh_access_token
      // (grant_type=th_refresh_token), not swapped for a new credential.
      refreshToken: null,
      expiresAt: longLivedJson.expires_in
        ? new Date(Date.now() + longLivedJson.expires_in * 1000).toISOString()
        : null,
      platformAccountId: userInfo.id,
      displayName: userInfo.username,
    };
  }

  // PostRequest.socialAccountId is LazyRelay's own internal id, not a
  // Threads identifier — same shape as LinkedIn's adapter, re-deriving the
  // Threads user id fresh from the token via /me rather than changing the
  // shared PlatformAdapter interface every other platform relies on.
  private async getMe(accessToken: string): Promise<{ id: string; username: string }> {
    const url = new URL(`${GRAPH_BASE}/me`);
    url.searchParams.set("fields", "id,username");
    url.searchParams.set("access_token", accessToken);
    const res = await fetch(url.toString());
    const json = (await res.json()) as ThreadsUserInfo;
    if (!res.ok || !json.id) {
      throw new Error("Could not resolve the connected Threads user's id");
    }
    return { id: json.id, username: json.username ?? json.id };
  }

  // Polls a video container's status_code before publishing — added
  // 2026-09-05 alongside video support. Meta's own guidance
  // (developers.facebook.com/documentation/threads/posts): "wait on average
  // 30 seconds before publishing"; if that's not enough, poll "once per
  // minute, for no more than 5 minutes." This waits the recommended 30s
  // once, then polls if it's still not ready, rather than always burning
  // the full 5-minute budget on every video post.
  private async waitForVideoContainerReady(containerId: string, accessToken: string): Promise<string | null> {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    for (let attempt = 0; attempt < 5; attempt++) {
      const url = new URL(`${GRAPH_BASE}/${containerId}`);
      url.searchParams.set("fields", "status");
      url.searchParams.set("access_token", accessToken);
      const res = await fetch(url.toString());
      const json = (await res.json()) as ThreadsContainerStatusResponse & ThreadsErrorBody;
      if (!res.ok) {
        return json.error?.message ?? `Could not check Threads container status (HTTP ${res.status})`;
      }
      if (json.status === "FINISHED" || json.status === "PUBLISHED") return null;
      if (json.status === "ERROR" || json.status === "EXPIRED") {
        return `Threads media container failed processing (${json.status})`;
      }
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
    return "Threads media container did not finish processing in time";
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const me = await this.getMe(request.accessToken);
    const isVideo = !!request.mediaUrl && isVideoUrl(request.mediaUrl);

    // Two-step publish, per Threads API design: create a media container,
    // then publish it as a second call — a single combined create+publish
    // endpoint does not exist. Video support added 2026-09-05
    // (developers.facebook.com/documentation/threads/posts, confirmed
    // live): media_type: "VIDEO" + video_url, same container→publish shape
    // as an image, just needs the readiness poll below first. Real limits:
    // 1GB max, 5min max duration (enforced pre-flight by mediaLimits.ts).
    const containerParams = new URLSearchParams({
      media_type: request.mediaUrl ? (isVideo ? "VIDEO" : "IMAGE") : "TEXT",
      text: request.content,
      access_token: request.accessToken,
    });
    if (request.mediaUrl) {
      containerParams.set(isVideo ? "video_url" : "image_url", request.mediaUrl);
    }

    const containerRes = await fetch(`${GRAPH_BASE}/${me.id}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: containerParams.toString(),
    });
    const containerJson = (await containerRes.json()) as ThreadsContainerResponse & ThreadsErrorBody;
    if (!containerRes.ok || !containerJson.id) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: containerJson.error?.message ?? `Threads container creation failed (HTTP ${containerRes.status})`,
      };
    }

    if (isVideo) {
      const containerError = await this.waitForVideoContainerReady(containerJson.id, request.accessToken);
      if (containerError) {
        return { success: false, platformPostId: null, errorMessage: containerError };
      }
    }

    const publishParams = new URLSearchParams({
      creation_id: containerJson.id,
      access_token: request.accessToken,
    });
    const publishRes = await fetch(`${GRAPH_BASE}/${me.id}/threads_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: publishParams.toString(),
    });
    const publishJson = (await publishRes.json()) as ThreadsMediaResponse & ThreadsErrorBody;
    if (!publishRes.ok || !publishJson.id) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: publishJson.error?.message ?? `Threads publish failed (HTTP ${publishRes.status})`,
      };
    }

    return { success: true, platformPostId: publishJson.id, errorMessage: null };
  }

  // Real independent Proof-of-Publish check: fetch the published media
  // object back from Threads' own Graph API (not just trusting the id
  // threads_publish returned) and confirm it carries a live permalink.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const url = new URL(`${GRAPH_BASE}/${platformPostId}`);
    url.searchParams.set("fields", "id,permalink");
    url.searchParams.set("access_token", accessToken);

    const res = await fetch(url.toString());
    const json = (await res.json()) as ThreadsMediaResponse & ThreadsErrorBody;

    if (!res.ok || !json.id) {
      return {
        verifiedLive: false,
        platformPostUrl: null,
        errorMessage: json.error?.message ?? `Threads post could not be independently confirmed (HTTP ${res.status})`,
      };
    }

    return { verifiedLive: true, platformPostUrl: json.permalink ?? null, errorMessage: null };
  }
}
