import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
} from "./types.js";

// Real, deliberate simplification, same shape as TikTok's SELF_ONLY/Pinterest's
// sandbox-host hardcode: a Facebook user can manage multiple Pages, but this
// adapter connects the FIRST Page returned by /me/accounts rather than
// building Page-selection UI — matches how every other single-target
// adapter here works. Revisit if a customer with multiple Pages needs to
// pick a specific one.
const AUTHORIZE_URL = "https://www.facebook.com/v25.0/dialog/oauth";
const TOKEN_URL = "https://graph.facebook.com/v25.0/oauth/access_token";
const GRAPH_BASE = "https://graph.facebook.com/v25.0";

const SCOPES = "pages_show_list,pages_read_engagement,pages_manage_posts,business_management";

interface FacebookTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: { message?: string };
}

interface FacebookPage {
  id: string;
  name: string;
  access_token: string;
}

interface FacebookPagesResponse {
  data?: FacebookPage[];
  error?: { message?: string };
}

interface FacebookPostResponse {
  id?: string;
  post_id?: string;
  error?: { message?: string };
}

interface FacebookPostDetail {
  id?: string;
  permalink_url?: string;
  error?: { message?: string };
}

export class FacebookAdapter implements PlatformAdapter {
  readonly platform: "facebook" = "facebook";

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

  private async exchangeForLongLivedUserToken(shortLivedToken: string): Promise<string> {
    const url = new URL(TOKEN_URL);
    url.searchParams.set("grant_type", "fb_exchange_token");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("client_secret", this.clientSecret);
    url.searchParams.set("fb_exchange_token", shortLivedToken);

    const res = await fetch(url.toString());
    const json = (await res.json()) as FacebookTokenResponse;
    if (!res.ok || !json.access_token) {
      throw new Error(json.error?.message ?? "Could not exchange for a long-lived Facebook token");
    }
    return json.access_token;
  }

  protected async getFirstPage(longLivedUserToken: string): Promise<FacebookPage> {
    const url = new URL(`${GRAPH_BASE}/me/accounts`);
    url.searchParams.set("fields", "id,name,access_token,instagram_business_account");
    url.searchParams.set("access_token", longLivedUserToken);

    const res = await fetch(url.toString());
    const json = (await res.json()) as FacebookPagesResponse;
    if (!res.ok || !json.data) {
      throw new Error(json.error?.message ?? "Could not list this account's Facebook Pages");
    }
    const page = json.data[0];
    if (!page) {
      throw new Error("No Facebook Page found — this account must manage at least one Page to connect");
    }
    return page;
  }

  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    const codeUrl = new URL(TOKEN_URL);
    codeUrl.searchParams.set("client_id", this.clientId);
    codeUrl.searchParams.set("client_secret", this.clientSecret);
    codeUrl.searchParams.set("redirect_uri", this.redirectUri);
    codeUrl.searchParams.set("code", code);

    const res = await fetch(codeUrl.toString());
    const json = (await res.json()) as FacebookTokenResponse;
    if (!res.ok || !json.access_token) {
      throw new Error(json.error?.message ?? "Facebook token exchange failed");
    }

    const longLivedUserToken = await this.exchangeForLongLivedUserToken(json.access_token);
    const page = await this.getFirstPage(longLivedUserToken);

    return {
      // Page access tokens minted from a long-lived user token do not
      // expire on their own — confirmed Meta behavior, distinct from the
      // user token they're derived from.
      accessToken: page.access_token,
      refreshToken: null,
      expiresAt: null,
      platformAccountId: page.id,
      displayName: page.name,
    };
  }

  private async getPageId(pageAccessToken: string): Promise<string> {
    const url = new URL(`${GRAPH_BASE}/me`);
    url.searchParams.set("fields", "id");
    url.searchParams.set("access_token", pageAccessToken);
    const res = await fetch(url.toString());
    const json = (await res.json()) as { id?: string; error?: { message?: string } };
    if (!res.ok || !json.id) {
      throw new Error(json.error?.message ?? "Could not resolve the connected Facebook Page's id");
    }
    return json.id;
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const pageId = await this.getPageId(request.accessToken);

    const endpoint = request.mediaUrl ? `${GRAPH_BASE}/${pageId}/photos` : `${GRAPH_BASE}/${pageId}/feed`;
    const params = new URLSearchParams({ access_token: request.accessToken });
    if (request.mediaUrl) {
      params.set("url", request.mediaUrl);
      params.set("caption", request.content);
    } else {
      params.set("message", request.content);
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const json = (await res.json()) as FacebookPostResponse;

    // A photo post's response id is the photo object, not the feed post —
    // post_id is the actual Page post id needed for verifyPublished().
    const postId = json.post_id ?? json.id;
    if (!res.ok || !postId) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: json.error?.message ?? `Facebook post failed (HTTP ${res.status})`,
      };
    }

    return { success: true, platformPostId: postId, errorMessage: null };
  }

  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const url = new URL(`${GRAPH_BASE}/${platformPostId}`);
    url.searchParams.set("fields", "id,permalink_url");
    url.searchParams.set("access_token", accessToken);

    const res = await fetch(url.toString());
    const json = (await res.json()) as FacebookPostDetail;

    if (!res.ok || !json.id) {
      return {
        verifiedLive: false,
        platformPostUrl: null,
        errorMessage: json.error?.message ?? `Facebook post could not be independently confirmed (HTTP ${res.status})`,
      };
    }

    return { verifiedLive: true, platformPostUrl: json.permalink_url ?? null, errorMessage: null };
  }
}
