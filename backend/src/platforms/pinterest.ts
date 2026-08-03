import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
} from "./types.js";

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

  // Pin creation requires a board_id and PostRequest has no board-selection
  // field yet (LazyRelay doesn't have a customer-facing board picker built —
  // tracked as a real gap, not an oversight). Until that exists, this posts
  // to whichever board the connected account's boards/list call returns
  // first, matching TikTok's SELF_ONLY stopgap: a real, working choice,
  // documented as provisional rather than silently hardcoded.
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

  async post(request: PostRequest): Promise<PostAttemptResult> {
    if (!request.mediaUrl) {
      return { success: false, platformPostId: null, errorMessage: "Pinterest Pins require an image URL" };
    }
    if (isVideoUrl(request.mediaUrl)) {
      // Video Pins need a separate cover_image_url that PostRequest doesn't
      // carry yet — returning a clear, honest failure rather than a broken
      // video-pin attempt. See the class-level comment in the summary for
      // the full endpoint shape once this is worth building out.
      return {
        success: false,
        platformPostId: null,
        errorMessage: "Pinterest video Pins are not yet supported by this adapter (needs a cover image field on PostRequest)",
      };
    }

    const boardId = await this.firstBoardId(request.accessToken);
    if (!boardId) {
      return { success: false, platformPostId: null, errorMessage: "No Pinterest board found on this account" };
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
        media_source: {
          source_type: "image_url",
          url: request.mediaUrl,
        },
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
