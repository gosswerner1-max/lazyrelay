import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
} from "./types.js";
import { fetchMediaForStreaming, buildStreamingMultipartBody, type RequestInitWithDuplex } from "./streamUpload.js";

// The browser-facing consent page always stays on the real pinterest.com
// host — only the API calls below move to the Sandbox subdomain.
const AUTHORIZE_URL = "https://www.pinterest.com/oauth/";

// This app currently has Trial access (see project-platform-app-registration
// memory) — confirmed live: Pinterest rejects Pin creation against the
// production API host for Trial apps ("use API Sandbox ... instead"), and
// Pinterest's own docs confirm every call (OAuth token exchange, reads, and
// writes alike) must go through api-sandbox.pinterest.com while on Trial,
// using its own separate tokens/entities from production. This is a
// deliberate stopgap mirroring TikTok's SELF_ONLY hardcode — switch back to
// api.pinterest.com once this app is approved for Standard access.
const API_BASE = "https://api-sandbox.pinterest.com";
const TOKEN_URL = `${API_BASE}/v5/oauth/token`;
const USER_ACCOUNT_URL = `${API_BASE}/v5/user_account`;
const BOARDS_URL = `${API_BASE}/v5/boards`;
const PINS_URL = `${API_BASE}/v5/pins`;
const MEDIA_URL = `${API_BASE}/v5/media`;

// Polling knobs for the register -> upload -> processing flow below. Pinterest
// gives no SLA for how long video processing takes; 20 * 3s is a generous
// bound that keeps a single post attempt from hanging indefinitely.
const MEDIA_POLL_ATTEMPTS = 20;
const MEDIA_POLL_INTERVAL_MS = 3000;

// pins:read/pins:write let us create + verify Pins; boards:read/boards:write
// are both needed to pick a board to post to — confirmed live: requesting
// only boards:read still got "Missing: ['boards:write']" back from Pinterest
// when creating a Pin against an existing board.
const SCOPES = "pins:read,pins:write,boards:read,boards:write,user_accounts:read";

interface PinterestTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

interface PinterestErrorBody {
  code?: number;
  message?: string;
}

interface PinterestAccount {
  username?: string;
  account_type?: string;
}

interface PinterestBoard {
  id: string;
  name: string;
}

interface PinterestBoardsPage {
  items?: PinterestBoard[];
}

interface PinterestPin {
  id?: string;
  link?: string | null;
}

interface PinterestMediaRegisterResponse {
  media_id?: string;
  media_type?: string;
  upload_url?: string;
  upload_parameters?: Record<string, string>;
}

interface PinterestMediaStatusResponse {
  media_id?: string;
  status?: string;
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v)(\?.*)?$/i.test(url);
}

export class PinterestAdapter implements PlatformAdapter {
  readonly platform: "pinterest" = "pinterest";

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly redirectUri: string,
  ) {}

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: SCOPES,
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    const basicAuth = Buffer.from(`${this.appId}:${this.appSecret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const json = (await res.json()) as PinterestTokenResponse & PinterestErrorBody;

    if (!res.ok || !json.access_token) {
      throw new Error(json.message ?? "Pinterest token exchange failed");
    }

    // Best-effort username lookup — a failure here shouldn't block the
    // connect flow (mirrors TikTokAdapter's non-fatal display-name lookup).
    let displayName: string | null = null;
    let platformAccountId = "unknown";
    try {
      const accountRes = await fetch(USER_ACCOUNT_URL, {
        headers: { Authorization: `Bearer ${json.access_token}` },
      });
      const accountJson = (await accountRes.json()) as PinterestAccount;
      if (accountJson.username) {
        displayName = accountJson.username;
        platformAccountId = accountJson.username;
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

  // Found 2026-08-17 during a sweep for the same bug class already fixed on
  // TikTok/Tumblr/YouTube/Bluesky: exchangeCode() above captures a real
  // refresh_token and a real expiresAt, but nothing ever used the refresh
  // token — every Pinterest connection would silently die once its access
  // token expired. Same grant shape as exchangeCode (Basic auth, form body).
  async refresh(refreshToken: string): Promise<OAuthExchangeResult> {
    const basicAuth = Buffer.from(`${this.appId}:${this.appSecret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const json = (await res.json()) as PinterestTokenResponse & PinterestErrorBody;
    if (!res.ok || !json.access_token) {
      throw new Error(json.message ?? "Pinterest token refresh failed");
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? refreshToken,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
      platformAccountId: "",
      displayName: "",
    };
  }

  // Fallback used when the caller doesn't pass PostRequest.boardId (older
  // scheduled_posts rows, or a customer who never picked a board via the
  // GET /social-accounts/:id/boards picker) — posts to whichever board the
  // connected account's boards/list call returns first, matching TikTok's
  // SELF_ONLY stopgap: a real, working choice, documented as provisional
  // rather than silently hardcoded.
  private async firstBoardId(accessToken: string): Promise<string | null> {
    const res = await fetch(`${BOARDS_URL}?page_size=1`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as PinterestBoardsPage;
    const existing = json.items?.[0]?.id;
    if (existing) return existing;

    // A brand-new Pinterest account has zero boards, so Pin creation would
    // fail every single time with no path forward — confirmed live during
    // the App Review demo recording (2026-08-03), where a freshly-connected
    // account hit this and burned all 4 scheduler retries before a board was
    // created by hand. Auto-create a default board rather than hard-failing.
    const createRes = await fetch(BOARDS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "LazyRelay Posts",
        description: "Default board created by LazyRelay for your scheduled Pins.",
      }),
    });
    if (!createRes.ok) return null;
    const createJson = (await createRes.json()) as PinterestBoard;
    return createJson.id ?? null;
  }

  /** Real board list for the customer-facing board picker (see
   *  GET /social-accounts/:id/boards in routes.ts) — lets a customer choose
   *  which board a Pin goes to, instead of always landing on
   *  firstBoardId()'s provisional first-or-auto-created choice. Returns an
   *  empty array rather than throwing on a non-2xx response, matching
   *  firstBoardId()'s own no-boards-yet handling — an empty picker is a
   *  legitimate state for a brand-new account, not an error. */
  async listBoards(accessToken: string): Promise<{ id: string; name: string }[]> {
    const res = await fetch(`${BOARDS_URL}?page_size=100`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as PinterestBoardsPage;
    return (json.items ?? []).map((b) => ({ id: b.id, name: b.name }));
  }

  // Video Pins can't reference a URL directly — Pinterest requires the video
  // bytes registered and uploaded to their S3 endpoint first, then a Pin
  // created against the resulting media_id. Three network round-trips: (1)
  // register (declares media_type: video, returns an upload_url + one-time
  // upload_parameters), (2) upload the file as multipart/form-data with
  // those parameters, (3) poll media status until Pinterest finishes
  // processing it. Confirmed against Pinterest's v5 docs (media-create,
  // create_pin) 2026-08-03 — no sandbox video-pin test was possible this
  // pass (see class-level note on credentials).
  private async registerVideoUpload(
    accessToken: string,
  ): Promise<{ mediaId: string; uploadUrl: string; uploadParameters: Record<string, string> } | { error: string }> {
    const res = await fetch(MEDIA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ media_type: "video" }),
    });
    const json = (await res.json()) as PinterestMediaRegisterResponse & PinterestErrorBody;
    if (!res.ok || !json.media_id || !json.upload_url || !json.upload_parameters) {
      return { error: json.message ?? `Pinterest media registration failed (HTTP ${res.status})` };
    }
    return { mediaId: json.media_id, uploadUrl: json.upload_url, uploadParameters: json.upload_parameters };
  }

  private async uploadVideoToS3(
    uploadUrl: string,
    uploadParameters: Record<string, string>,
    videoUrl: string,
  ): Promise<string | null> {
    // Streamed instead of buffered via .blob() (2026-09-05) -- see
    // streamUpload.ts. This endpoint is Pinterest's S3-style presigned
    // upload, which needs the signed form fields (key/policy/signature)
    // ahead of the actual file part in the same multipart body --
    // buildStreamingMultipartBody supports mixed string + file parts for
    // exactly this shape.
    const media = await fetchMediaForStreaming(videoUrl);
    if (!media) {
      return `Failed to fetch video from ${videoUrl}`;
    }
    const parts: Parameters<typeof buildStreamingMultipartBody>[0] = Object.entries(uploadParameters).map(
      ([key, value]) => ({ fieldName: key, value }),
    );
    parts.push({
      fieldName: "file",
      value: { filename: "video.mp4", contentType: media.contentType, data: media.body, sizeBytes: media.sizeBytes },
    });
    const { body, contentType, contentLength } = buildStreamingMultipartBody(parts);
    // CAUGHT LIVE 2026-09-05: Pinterest's S3-style upload rejects a
    // chunked-transfer body with 411 Length Required -- it needs a real
    // Content-Length, which is why sizeBytes is passed above (see
    // buildStreamingMultipartBody's own comment for how this is computed
    // without buffering the file).
    if (contentLength == null) {
      return "Could not determine video size from storage (missing Content-Length) — Pinterest's upload requires a known content length";
    }

    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": contentType, "Content-Length": String(contentLength) },
      body,
      duplex: "half",
    } as RequestInitWithDuplex);
    if (!uploadRes.ok && uploadRes.status !== 204) {
      return `Pinterest video upload to S3 failed (HTTP ${uploadRes.status})`;
    }
    return null;
  }

  private async waitForMediaProcessing(mediaId: string, accessToken: string): Promise<string | null> {
    for (let attempt = 0; attempt < MEDIA_POLL_ATTEMPTS; attempt++) {
      const res = await fetch(`${MEDIA_URL}/${mediaId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const json = (await res.json()) as PinterestMediaStatusResponse & PinterestErrorBody;
      if (!res.ok) {
        return json.message ?? `Pinterest media status check failed (HTTP ${res.status})`;
      }
      if (json.status === "succeeded") return null;
      if (json.status === "failed") return "Pinterest video processing failed";
      await new Promise((resolve) => setTimeout(resolve, MEDIA_POLL_INTERVAL_MS));
    }
    return "Pinterest video processing did not finish in time";
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    if (!request.mediaUrl) {
      return { success: false, platformPostId: null, errorMessage: "Pinterest Pins require an image URL" };
    }

    const boardId = request.boardId ?? (await this.firstBoardId(request.accessToken));
    if (!boardId) {
      return { success: false, platformPostId: null, errorMessage: "No Pinterest board found on this account" };
    }

    let mediaSource: Record<string, unknown>;

    if (isVideoUrl(request.mediaUrl)) {
      if (!request.coverImageUrl) {
        return {
          success: false,
          platformPostId: null,
          errorMessage: "Pinterest video Pins require a cover image",
        };
      }

      const registered = await this.registerVideoUpload(request.accessToken);
      if ("error" in registered) {
        return { success: false, platformPostId: null, errorMessage: registered.error };
      }

      const uploadError = await this.uploadVideoToS3(registered.uploadUrl, registered.uploadParameters, request.mediaUrl);
      if (uploadError) {
        return { success: false, platformPostId: null, errorMessage: uploadError };
      }

      const processingError = await this.waitForMediaProcessing(registered.mediaId, request.accessToken);
      if (processingError) {
        return { success: false, platformPostId: null, errorMessage: processingError };
      }

      mediaSource = {
        source_type: "video_id",
        cover_image_url: request.coverImageUrl,
        media_id: registered.mediaId,
      };
    } else {
      mediaSource = {
        source_type: "image_url",
        url: request.mediaUrl,
      };
    }

    const res = await fetch(PINS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        board_id: boardId,
        title: request.content.slice(0, 100),
        description: request.content.slice(0, 500),
        media_source: mediaSource,
        ...(request.destinationLink ? { link: request.destinationLink } : {}),
      }),
    });
    const json = (await res.json()) as PinterestPin & PinterestErrorBody;

    if (!res.ok || !json.id) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: json.message ?? `Pinterest pin creation failed (HTTP ${res.status})`,
      };
    }

    return { success: true, platformPostId: json.id, errorMessage: null };
  }

  // Unlike TikTok's async publish flow, Pinterest Pin creation is synchronous
  // — a 201 from post() means the Pin object already exists. verifyPublished
  // still does a real independent GET rather than trusting post()'s response,
  // per the Proof-of-Publish discipline this whole interface exists for.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const res = await fetch(`${PINS_URL}/${platformPostId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json()) as PinterestPin & PinterestErrorBody;

    if (!res.ok || json.id !== platformPostId) {
      return {
        verifiedLive: false,
        platformPostUrl: null,
        errorMessage: json.message ?? `Pinterest pin verification failed (HTTP ${res.status})`,
      };
    }

    return {
      verifiedLive: true,
      platformPostUrl: json.link ?? `https://www.pinterest.com/pin/${platformPostId}/`,
      errorMessage: null,
    };
  }
}
