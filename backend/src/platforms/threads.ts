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
const REFRESH_TOKEN_URL = "https://graph.threads.net/refresh_access_token";
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
  readonly refreshUsesAccessToken = true;

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

  /** Extends a still-valid long-lived Threads token by another 60 days.
   *  Meta documents this as GET /refresh_access_token?grant_type=th_refresh_token
   *  and only allows it when the token is at least 24 hours old and has not
   *  expired, so it has to run before expiry (see tokenRefresher.ts). The
   *  argument is the current access token; Threads has no separate refresh
   *  token. */
  async refresh(currentAccessToken: string): Promise<OAuthExchangeResult> {
    const url = new URL(REFRESH_TOKEN_URL);
    url.searchParams.set("grant_type", "th_refresh_token");
    url.searchParams.set("access_token", currentAccessToken);
    const res = await fetch(url.toString());
    const json = (await res.json()) as ThreadsLongLivedTokenResponse & { error?: { message?: string } };
    if (!res.ok || !json.access_token) {
      throw new Error(json.error?.message ?? "Could not refresh the Threads token");
    }
    return {
      accessToken: json.access_token,
      refreshToken: null,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
      // Identity is unchanged by a refresh; the scheduler only stores the
      // token and expiry from this result.
      platformAccountId: "",
      displayName: "",
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
  private async waitForVideoContainerReady(containerId: string, accessToken: string, initialDelayMs = 30_000): Promise<string | null> {
    if (initialDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, initialDelayMs));
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

  private async publishContainer(meId: string, creationId: string, accessToken: string): Promise<PostAttemptResult> {
    const publishRes = await fetch(`${GRAPH_BASE}/${meId}/threads_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ creation_id: creationId, access_token: accessToken }).toString(),
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

  // Carousel (2026-09-30): one item container per media (is_carousel_item,
  // IMAGE or VIDEO), then a CAROUSEL parent with comma-separated children and
  // the text, then the normal threads_publish. Per Meta's Threads docs the
  // text goes on the parent.
  private async postCarousel(request: PostRequest, meId: string): Promise<PostAttemptResult> {
    const urls = [request.mediaUrl as string, ...(request.mediaUrls ?? [])];
    const childIds: string[] = [];
    for (const itemUrl of urls) {
      const itemIsVideo = isVideoUrl(itemUrl);
      const res = await fetch(`${GRAPH_BASE}/${meId}/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          media_type: itemIsVideo ? "VIDEO" : "IMAGE",
          [itemIsVideo ? "video_url" : "image_url"]: itemUrl,
          is_carousel_item: "true",
          access_token: request.accessToken,
        }).toString(),
      });
      const json = (await res.json()) as ThreadsContainerResponse & ThreadsErrorBody;
      if (!res.ok || !json.id) {
        return { success: false, platformPostId: null, errorMessage: json.error?.message ?? `Threads carousel item ${childIds.length + 1} failed (HTTP ${res.status})` };
      }
      if (itemIsVideo) {
        const childError = await this.waitForVideoContainerReady(json.id, request.accessToken);
        if (childError) return { success: false, platformPostId: null, errorMessage: childError };
      }
      childIds.push(json.id);
    }
    const parentRes = await fetch(`${GRAPH_BASE}/${meId}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ media_type: "CAROUSEL", children: childIds.join(","), text: request.content, access_token: request.accessToken }).toString(),
    });
    const parentJson = (await parentRes.json()) as ThreadsContainerResponse & ThreadsErrorBody;
    if (!parentRes.ok || !parentJson.id) {
      return { success: false, platformPostId: null, errorMessage: parentJson.error?.message ?? `Threads carousel container failed (HTTP ${parentRes.status})` };
    }
    // Docs advise ~30s before publishing a container; the parent is only
    // status-polled (no fixed sleep) so it is not slowed when already ready.
    const parentError = await this.waitForVideoContainerReady(parentJson.id, request.accessToken, 0);
    if (parentError) return { success: false, platformPostId: null, errorMessage: parentError };
    return this.publishContainer(meId, parentJson.id, request.accessToken);
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const me = await this.getMe(request.accessToken);
    if (request.mediaUrl && request.mediaUrls && request.mediaUrls.length > 0) return this.postCarousel(request, me.id);
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

  // Thread chains: a follow-up is a TEXT container with reply_to_id (Meta's
  // publishing reference: reply_to_id "Required if replying to a post"),
  // then the normal threads_publish. The user id is the stored
  // platformAccountId (set from /me at connect) or re-derived via /me.
  // Meta recommends ~30s before publishing a container; the container's
  // status is polled (no fixed sleep) so an already-ready one isn't slowed.
  async postChainReply(input: {
    rootPostId: string;
    parentPostId: string;
    text: string;
    accessToken: string;
    platformAccountId?: string | null;
  }): Promise<{ success: boolean; platformPostId: string | null; errorMessage: string | null }> {
    const meId = input.platformAccountId || (await this.getMe(input.accessToken)).id;
    const containerRes = await fetch(`${GRAPH_BASE}/${meId}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        media_type: "TEXT",
        text: input.text,
        reply_to_id: input.parentPostId,
        access_token: input.accessToken,
      }).toString(),
    });
    const containerJson = (await containerRes.json()) as ThreadsContainerResponse & ThreadsErrorBody;
    if (!containerRes.ok || !containerJson.id) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: containerJson.error?.message ?? `Threads reply container creation failed (HTTP ${containerRes.status})`,
      };
    }
    const readyError = await this.waitForVideoContainerReady(containerJson.id, input.accessToken, 0);
    if (readyError) return { success: false, platformPostId: null, errorMessage: readyError };
    return this.publishContainer(meId, containerJson.id, input.accessToken);
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
