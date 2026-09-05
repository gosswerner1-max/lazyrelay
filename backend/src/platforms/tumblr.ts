import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
} from "./types.js";
import { fetchMediaForStreaming, buildStreamingMultipartBody, type RequestInitWithDuplex } from "./streamUpload.js";

// Tumblr API v2 supports real OAuth 2.0 (confirmed via Tumblr's own docs,
// not assumed) — standard authorize + token exchange, distinct from the
// legacy OAuth 1.0a some older Tumblr integrations still use. Every
// response wraps the real payload in {meta:{status,msg}, response:{...}}.
const AUTHORIZE_URL = "https://www.tumblr.com/oauth2/authorize";
const TOKEN_URL = "https://api.tumblr.com/v2/oauth2/token";
const API_BASE = "https://api.tumblr.com/v2";

const SCOPES = "write offline_access";

interface TumblrEnvelope<T> {
  meta?: { status?: number; msg?: string };
  response?: T;
  errors?: Array<{ title?: string; detail?: string }>;
}

interface TumblrTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface TumblrBlog {
  name?: string;
  url?: string;
  primary?: boolean;
}

interface TumblrUserInfo {
  user?: { blogs?: TumblrBlog[] };
}

interface TumblrPostResponse {
  id?: number | string;
  post_url?: string;
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v|webm)(\?.*)?$/i.test(url);
}

export class TumblrAdapter implements PlatformAdapter {
  readonly platform: "tumblr" = "tumblr";

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: "code",
      scope: SCOPES,
      redirect_uri: this.redirectUri,
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
      }),
    });
    const json = (await res.json()) as TumblrTokenResponse;
    if (!res.ok || !json.access_token) {
      throw new Error(json.error_description ?? json.error ?? "Tumblr token exchange failed");
    }

    const userRes = await fetch(`${API_BASE}/user/info`, {
      headers: { Authorization: `Bearer ${json.access_token}` },
    });
    const userJson = (await userRes.json()) as TumblrEnvelope<TumblrUserInfo>;
    const blogs = userJson.response?.user?.blogs ?? [];
    const primaryBlog = blogs.find((b) => b.primary) ?? blogs[0];
    if (!userRes.ok || !primaryBlog?.name) {
      throw new Error(userJson.errors?.[0]?.detail ?? "Could not find a Tumblr blog on this account");
    }

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
      platformAccountId: primaryBlog.name,
      displayName: primaryBlog.name,
    };
  }

  // Tumblr OAuth 2.0 access tokens expire in ~1 hour; offline_access scope
  // provides a refresh token that rotates on each use (valid 1 year or until
  // consumed). Same grant_type=refresh_token pattern as TikTok.
  async refresh(refreshToken: string): Promise<OAuthExchangeResult> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    const json = (await res.json()) as TumblrTokenResponse;
    if (!res.ok || !json.access_token) {
      throw new Error(json.error_description ?? json.error ?? "Tumblr token refresh failed");
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
      platformAccountId: "",
      displayName: "",
    };
  }

  // platformAccountId (the blog name) isn't passed through PostRequest, so
  // it's re-derived from the access token here — same pattern as every
  // other adapter that needs a platform-native id at post time.
  private async getBlogName(accessToken: string): Promise<string> {
    const res = await fetch(`${API_BASE}/user/info`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json()) as TumblrEnvelope<TumblrUserInfo>;
    const blogs = json.response?.user?.blogs ?? [];
    const primaryBlog = blogs.find((b) => b.primary) ?? blogs[0];
    if (!res.ok || !primaryBlog?.name) {
      throw new Error(json.errors?.[0]?.detail ?? "Could not resolve the connected Tumblr blog");
    }
    return primaryBlog.name;
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const blogName = await this.getBlogName(request.accessToken);
    const postUrl = `${API_BASE}/blog/${encodeURIComponent(blogName)}/posts`;

    let res: Response;
    if (request.mediaUrl && isVideoUrl(request.mediaUrl)) {
      // Video support added 2026-09-05, CORRECTED live the same day: the
      // NPF video block's `url` field is NOT a generic hosted-file fetch
      // the way Meta/Threads' video_url is -- confirmed live it rejects an
      // arbitrary directly-hosted MP4 URL ("Something goofed. Try again."
      // on every attempt, including with `provider: "tumblr"` set). The
      // REAL working path is native multipart upload: a `json` field
      // carrying the post body (the video block references a plain
      // `identifier` string, not a URL) plus a same-named binary file part
      // -- confirmed live with a real 201 Created. Streamed rather than
      // buffered (see streamUpload.ts), same as every other platform in
      // this build.
      const media = await fetchMediaForStreaming(request.mediaUrl);
      if (!media) {
        return { success: false, platformPostId: null, errorMessage: `Could not fetch video from ${request.mediaUrl}` };
      }
      const identifier = "video0";
      const jsonBody = JSON.stringify({
        content: [
          { type: "text", text: request.content },
          { type: "video", media: { type: "video/mp4", identifier } },
        ],
        layout: [],
        state: "published",
      });
      const { body, contentType, contentLength } = buildStreamingMultipartBody([
        { fieldName: "json", value: jsonBody },
        { fieldName: identifier, value: { filename: "video.mp4", contentType: media.contentType, data: media.body, sizeBytes: media.sizeBytes } },
      ]);
      res = await fetch(postUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${request.accessToken}`,
          "Content-Type": contentType,
          ...(contentLength != null ? { "Content-Length": String(contentLength) } : {}),
        },
        body,
        duplex: "half",
      } as RequestInitWithDuplex);
    } else {
      const content: Array<{ type: string; text?: string; media?: Array<{ url: string; type: string }> }> = [
        { type: "text", text: request.content },
      ];
      if (request.mediaUrl) {
        content.push({ type: "image", media: [{ url: request.mediaUrl, type: "image/jpeg" }] });
      }
      res = await fetch(postUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${request.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content, layout: [], state: "published" }),
      });
    }
    const json = (await res.json()) as TumblrEnvelope<TumblrPostResponse>;

    const postId = json.response?.id;
    if (!res.ok || !postId) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: json.errors?.[0]?.detail ?? json.meta?.msg ?? `Tumblr post failed (HTTP ${res.status})`,
      };
    }

    // platformPostId stores "blogName:postId" since verifyPublished needs
    // both to look the post back up.
    return { success: true, platformPostId: `${blogName}:${postId}`, errorMessage: null };
  }

  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const [blogName, postId] = platformPostId.split(":");
    if (!blogName || !postId) {
      return { verifiedLive: false, platformPostUrl: null, errorMessage: `Not a valid Tumblr post id: ${platformPostId}` };
    }

    const res = await fetch(`${API_BASE}/blog/${encodeURIComponent(blogName)}/posts/${postId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json()) as TumblrEnvelope<TumblrPostResponse>;

    if (!res.ok || !json.response?.id) {
      return {
        verifiedLive: false,
        platformPostUrl: null,
        errorMessage: json.errors?.[0]?.detail ?? `Tumblr post could not be independently confirmed (HTTP ${res.status})`,
      };
    }

    return {
      verifiedLive: true,
      platformPostUrl: json.response.post_url ?? null,
      errorMessage: null,
    };
  }
}
