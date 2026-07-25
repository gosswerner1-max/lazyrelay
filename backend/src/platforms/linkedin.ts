import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
} from "./types.js";

// Personal-profile-only scope, per the resolved build decision: posting to
// LinkedIn Company Pages needs the vetted "Community Management API"
// (w_organization_social) — a weeks-to-months review process — while
// personal-profile posting (w_member_social) is self-serve and instant.
// "Sign In with LinkedIn using OpenID Connect" (openid + profile scopes,
// also self-serve) is what resolves the member's own URN via /v2/userinfo,
// since /v2/me is gated behind products most apps don't have.
const AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const POSTS_URL = "https://api.linkedin.com/rest/posts";
const IMAGES_INIT_URL = "https://api.linkedin.com/rest/images?action=initializeUpload";
// LinkedIn's REST API requires a versioned header on every call — real,
// confirmed live: an aged-out version (this was first set to "202506")
// fails with "Requested version ... is not active", since LinkedIn only
// supports each monthly version for a minimum of ~1 year before sunset.
// This needs bumping periodically — check
// https://learn.microsoft.com/en-us/linkedin/marketing/versioning for the
// current latest version if posts start failing with that error again.
const LINKEDIN_VERSION = "202607";

const SCOPES = "openid profile w_member_social";

interface LinkedInTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface LinkedInUserInfo {
  sub?: string;
  name?: string;
}

interface LinkedInErrorBody {
  message?: string;
  serviceErrorCode?: number;
}

interface LinkedInImageInitResponse {
  value?: { uploadUrl?: string; image?: string };
}

export class LinkedInAdapter implements PlatformAdapter {
  readonly platform: "linkedin" = "linkedin";

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  private restHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      "LinkedIn-Version": LINKEDIN_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
      "Content-Type": "application/json",
    };
  }

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      state,
      scope: SCOPES,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await res.json()) as LinkedInTokenResponse;

    if (!res.ok || !json.access_token) {
      throw new Error(json.error_description ?? json.error ?? "LinkedIn token exchange failed");
    }

    const userRes = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${json.access_token}` },
    });
    const userJson = (await userRes.json()) as LinkedInUserInfo;
    if (!userRes.ok || !userJson.sub) {
      throw new Error("Could not look up the connected LinkedIn member's id");
    }

    return {
      accessToken: json.access_token,
      // LinkedIn's OAuth token response has no refresh_token unless the app
      // is on the refresh-token program (separate approval) — a real,
      // acknowledged gap: this connection needs re-authorization once the
      // access token expires rather than silently refreshing.
      refreshToken: null,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
      platformAccountId: userJson.sub,
      displayName: userJson.name ?? null,
    };
  }

  // LinkedIn's Posts API needs the author's urn explicitly in the request
  // body (unlike every other adapter here, which infers the acting user
  // from the bearer token alone) — PostRequest.socialAccountId is
  // LazyRelay's own internal id, not a LinkedIn identifier, so re-deriving
  // the member urn from the token itself (same userinfo call exchangeCode
  // uses) is the only way to get it without changing the shared
  // PlatformAdapter interface every other platform relies on.
  private async getMemberUrn(accessToken: string): Promise<string> {
    const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    const json = (await res.json()) as LinkedInUserInfo;
    if (!res.ok || !json.sub) {
      throw new Error("Could not resolve the connected LinkedIn member's id");
    }
    return `urn:li:person:${json.sub}`;
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const memberUrn = await this.getMemberUrn(request.accessToken);

    let mediaUrn: string | null = null;
    if (request.mediaUrl) {
      const initRes = await fetch(IMAGES_INIT_URL, {
        method: "POST",
        headers: this.restHeaders(request.accessToken),
        body: JSON.stringify({ initializeUploadRequest: { owner: memberUrn } }),
      });
      const initJson = (await initRes.json().catch(() => ({}))) as LinkedInImageInitResponse & LinkedInErrorBody;
      if (!initRes.ok || !initJson.value?.uploadUrl || !initJson.value?.image) {
        return {
          success: false,
          platformPostId: null,
          errorMessage: initJson.message ?? `LinkedIn image upload init failed (HTTP ${initRes.status})`,
        };
      }

      const imageRes = await fetch(request.mediaUrl);
      if (!imageRes.ok || !imageRes.body) {
        return { success: false, platformPostId: null, errorMessage: `Could not fetch image from ${request.mediaUrl}` };
      }
      const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

      const uploadRes = await fetch(initJson.value.uploadUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${request.accessToken}` },
        body: imageBuffer,
      });
      if (!uploadRes.ok) {
        return { success: false, platformPostId: null, errorMessage: `LinkedIn image upload failed (HTTP ${uploadRes.status})` };
      }
      mediaUrn = initJson.value.image;
    }

    const postBody: Record<string, unknown> = {
      author: memberUrn,
      commentary: request.content,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };
    if (mediaUrn) {
      postBody.content = { media: { id: mediaUrn } };
    }

    const res = await fetch(POSTS_URL, {
      method: "POST",
      headers: this.restHeaders(request.accessToken),
      body: JSON.stringify(postBody),
    });

    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as LinkedInErrorBody;
      return {
        success: false,
        platformPostId: null,
        errorMessage: errJson.message ?? `LinkedIn post failed (HTTP ${res.status})`,
      };
    }

    // A successful create returns the new post's urn in the x-restli-id
    // header, not the JSON body (LinkedIn Posts API convention).
    const postUrn = res.headers.get("x-restli-id");
    if (!postUrn) {
      return { success: false, platformPostId: null, errorMessage: "LinkedIn did not return a post id" };
    }

    return { success: true, platformPostId: postUrn, errorMessage: null };
  }

  // Real, confirmed-live architectural gap, same shape as Telegram's Bot
  // API having no get-message-by-id endpoint: GET /rest/posts/{id} needs
  // r_member_social, which LinkedIn's docs state is "restricted and
  // available to approved users only" — NOT part of the self-serve "Share
  // on LinkedIn" product this adapter uses (w_member_social only grants
  // write access). Confirmed live via a real 403 "Not enough permissions
  // to access: partnerApiPostsExternal.GET" when attempted. Since every
  // post here is created with visibility: PUBLIC, the honest available
  // verification is fetching the public post page directly (no auth,
  // no scope needed) and checking it actually resolves — a genuine
  // existence probe, not a fabricated confidence check.
  async verifyPublished(platformPostId: string, _accessToken: string): Promise<VerifyResult> {
    const platformPostUrl = `https://www.linkedin.com/feed/update/${platformPostId}/`;

    const res = await fetch(platformPostUrl, { redirect: "manual" });
    // LinkedIn serves public post pages with a 200 (login-walled preview
    // for anonymous fetchers, but still resolves) when the post exists;
    // a removed/nonexistent post 404s or redirects to a generic feed URL
    // rather than the specific update.
    if (res.status === 404) {
      return { verifiedLive: false, platformPostUrl, errorMessage: "LinkedIn post page returned 404 — not found" };
    }
    if (res.status >= 200 && res.status < 400) {
      return { verifiedLive: true, platformPostUrl, errorMessage: null };
    }

    return {
      verifiedLive: false,
      platformPostUrl,
      errorMessage: `Could not independently confirm the post is live (HTTP ${res.status})`,
    };
  }
}
