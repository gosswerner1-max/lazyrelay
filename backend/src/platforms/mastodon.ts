import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
  CommentsResult,
  PostMetrics,
  CommentPostResult,
} from "./types.js";

// Real, confirmed platform gotcha: Mastodon is decentralized — every
// instance (mastodon.social, hachyderm.io, ...) is its own OAuth server
// with its own app registration. There is no federated "sign in with
// Mastodon" spanning arbitrary instances; every real integration either
// asks the user which instance they're on, or (like this stopgap) supports
// one fixed instance. Since PlatformAdapter's getAuthorizeUrl/exchangeCode
// don't carry a customer-chosen instance host, this adapter hardcodes a
// single default instance — the same shape as TikTok's SELF_ONLY posting
// scope and Pinterest's sandbox-host hardcode: a real, working, honestly
// documented gap, not a silent limitation. Revisit once the connect flow
// can collect an instance host from the customer (a real UI gap, not just
// a backend one) and register/cache per-instance client credentials.
const DEFAULT_INSTANCE = "https://mastodon.social";

// write:statuses lets us post; write:media is a SEPARATE granular scope
// required by POST /api/v2/media, and read:statuses is a separate scope
// again required by GET /api/v1/statuses/:id (verifyPublished) — all three
// confirmed live via real 403 "This action is outside the authorized
// scopes" responses when omitted, even though the adjacent write:statuses/
// read:accounts scopes worked fine. Mastodon's OAuth scopes are strictly
// per-resource, never implied by a sibling scope. read:accounts lets us
// look up the connected account's real display name instead of just the
// opaque user id.
const SCOPES = "write:statuses write:media read:statuses read:accounts";

interface MastodonAppCredentials {
  client_id?: string;
  client_secret?: string;
  error?: string;
}

interface MastodonTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface MastodonAccount {
  id?: string;
  username?: string;
  display_name?: string;
  followers_count?: number;
}

interface MastodonMedia {
  id?: string;
  url?: string | null;
}

interface MastodonStatus {
  id?: string;
  url?: string | null;
  error?: string;
  favourites_count?: number;
  reblogs_count?: number;
  replies_count?: number;
}

interface MastodonContext {
  descendants?: Array<{
    id?: string;
    url?: string | null;
    content?: string;
    created_at?: string;
    account?: { display_name?: string; username?: string };
  }>;
  error?: string;
}

export class MastodonAdapter implements PlatformAdapter {
  readonly platform: "mastodon" = "mastodon";

  // Mastodon app registration (POST /api/v1/apps) is instant and
  // self-service — no review gate, confirmed live against the docs — so
  // rather than requiring these as env-configured secrets like every other
  // platform, this adapter registers itself against DEFAULT_INSTANCE on
  // first use and caches the result for the life of the process. A real
  // per-instance cache (keyed by hostname, persisted in the DB) is future
  // work for when the connect flow supports customer-chosen instances.
  private appCredentials: { clientId: string; clientSecret: string } | null = null;

  constructor(private readonly redirectUri: string) {}

  private async ensureAppRegistered(): Promise<{ clientId: string; clientSecret: string }> {
    if (this.appCredentials) return this.appCredentials;

    const res = await fetch(`${DEFAULT_INSTANCE}/api/v1/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "LazyRelay",
        redirect_uris: this.redirectUri,
        scopes: SCOPES,
        website: "https://lazyrelay.com",
      }),
    });
    const json = (await res.json()) as MastodonAppCredentials;
    if (!res.ok || !json.client_id || !json.client_secret) {
      throw new Error(json.error ?? "Mastodon app registration failed");
    }

    this.appCredentials = { clientId: json.client_id, clientSecret: json.client_secret };
    return this.appCredentials;
  }

  async getAuthorizeUrl(state: string): Promise<string> {
    const { clientId } = await this.ensureAppRegistered();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: this.redirectUri,
      scope: SCOPES,
      state,
    });
    return `${DEFAULT_INSTANCE}/oauth/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    const { clientId, clientSecret } = await this.ensureAppRegistered();

    const res = await fetch(`${DEFAULT_INSTANCE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: this.redirectUri,
        scope: SCOPES,
      }).toString(),
    });
    const json = (await res.json()) as MastodonTokenResponse;

    if (!res.ok || !json.access_token) {
      throw new Error(json.error_description ?? json.error ?? "Mastodon token exchange failed");
    }

    // Best-effort account lookup — a failure here shouldn't block the
    // connect flow (mirrors every other adapter's non-fatal display-name
    // lookup).
    let displayName: string | null = null;
    let platformAccountId = "unknown";
    try {
      const accountRes = await fetch(`${DEFAULT_INSTANCE}/api/v1/accounts/verify_credentials`, {
        headers: { Authorization: `Bearer ${json.access_token}` },
      });
      const accountJson = (await accountRes.json()) as MastodonAccount;
      if (accountJson.id) {
        platformAccountId = accountJson.id;
        displayName = accountJson.display_name || accountJson.username || null;
      }
    } catch {
      // Non-fatal — see comment above.
    }

    // Mastodon access tokens don't expire and there's no refresh token in
    // the standard flow — confirmed via the docs' token response shape.
    return {
      accessToken: json.access_token,
      refreshToken: null,
      expiresAt: null,
      platformAccountId,
      displayName,
    };
  }

  // altText (2026-08-16): Mastodon's media-upload endpoint accepts an
  // optional "description" field for exactly this — the value it returns
  // via the API/renders to users as the image's alt text. Omitted entirely
  // when null, same as not passing it at all — no behavior change for
  // uploads that don't have one.
  private async uploadMedia(mediaUrl: string, accessToken: string, altText: string | null): Promise<string | null> {
    const mediaRes = await fetch(mediaUrl);
    if (!mediaRes.ok || !mediaRes.body) return null;
    const buffer = Buffer.from(await mediaRes.arrayBuffer());
    const contentType = mediaRes.headers.get("content-type") ?? "application/octet-stream";

    const form = new FormData();
    form.append("file", new Blob([buffer], { type: contentType }), "media");
    if (altText) form.append("description", altText);

    const res = await fetch(`${DEFAULT_INSTANCE}/api/v2/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });
    if (res.status !== 200 && res.status !== 202) return null;
    const json = (await res.json()) as MastodonMedia;
    return json.id ?? null;
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    let mediaIds: string[] | undefined;
    if (request.mediaUrl) {
      const mediaId = await this.uploadMedia(request.mediaUrl, request.accessToken, request.mediaAltText ?? null);
      if (!mediaId) {
        return { success: false, platformPostId: null, errorMessage: `Could not upload media from ${request.mediaUrl}` };
      }
      mediaIds = [mediaId];
    }

    const res = await fetch(`${DEFAULT_INSTANCE}/api/v1/statuses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: request.content,
        visibility: "public",
        ...(mediaIds ? { media_ids: mediaIds } : {}),
      }),
    });
    const json = (await res.json()) as MastodonStatus;

    if (!res.ok || !json.id) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: json.error ?? `Mastodon status creation failed (HTTP ${res.status})`,
      };
    }

    return { success: true, platformPostId: json.id, errorMessage: null };
  }

  // Mastodon status creation is synchronous — a 200 from post() means the
  // status already exists. verifyPublished still does a real independent
  // GET rather than trusting post()'s response, per the Proof-of-Publish
  // discipline this whole interface exists for.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const res = await fetch(`${DEFAULT_INSTANCE}/api/v1/statuses/${platformPostId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json()) as MastodonStatus;

    if (!res.ok || json.id !== platformPostId) {
      return {
        verifiedLive: false,
        platformPostUrl: null,
        errorMessage: json.error ?? `Mastodon status verification failed (HTTP ${res.status})`,
      };
    }

    return {
      verifiedLive: true,
      platformPostUrl: json.url ?? `${DEFAULT_INSTANCE}/web/statuses/${platformPostId}`,
      errorMessage: null,
    };
  }

  // /context's "descendants" are every reply in the thread below this
  // status, not strictly one-level-deep comments — the closest real
  // equivalent Mastodon's API offers to "comments on this post."
  async getComments(platformPostId: string, accessToken: string): Promise<CommentsResult> {
    const res = await fetch(`${DEFAULT_INSTANCE}/api/v1/statuses/${platformPostId}/context`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json().catch(() => ({}))) as MastodonContext;
    if (!res.ok) {
      return { comments: [], errorMessage: json.error ?? `Could not load replies (HTTP ${res.status})` };
    }

    const comments = (json.descendants ?? []).flatMap((reply) => {
      if (!reply.id) return [];
      return [
        {
          id: reply.id,
          author: reply.account?.display_name || reply.account?.username || "Unknown",
          text: (reply.content ?? "").replace(/<[^>]+>/g, "").trim(),
          url: reply.url ?? null,
          createdAt: reply.created_at ?? null,
        },
      ];
    });
    return { comments, errorMessage: null };
  }

  // A reply is just a status with in_reply_to_id set — write:statuses
  // (already granted) covers this, no new scope needed.
  async replyToComment(commentId: string, text: string, accessToken: string): Promise<CommentPostResult> {
    const res = await fetch(`${DEFAULT_INSTANCE}/api/v1/statuses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: text, in_reply_to_id: commentId, visibility: "public" }),
    });
    const json = (await res.json().catch(() => ({}))) as MastodonStatus;

    if (!res.ok || !json.id) {
      return { success: false, errorMessage: json.error ?? `Mastodon reply failed (HTTP ${res.status})` };
    }

    return { success: true, errorMessage: null };
  }

  // Same endpoint verifyPublished already uses — the status object carries
  // its own engagement counts directly, no separate insights call needed.
  async getPostMetrics(platformPostId: string, accessToken: string): Promise<PostMetrics> {
    const res = await fetch(`${DEFAULT_INSTANCE}/api/v1/statuses/${platformPostId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json().catch(() => ({}))) as MastodonStatus;
    if (!res.ok || json.id !== platformPostId) {
      return {
        likes: null,
        comments: null,
        shares: null,
        views: null,
        errorMessage: json.error ?? `Could not load metrics (HTTP ${res.status})`,
      };
    }
    return {
      likes: json.favourites_count ?? null,
      comments: json.replies_count ?? null,
      shares: json.reblogs_count ?? null,
      views: null, // Mastodon doesn't expose view counts
      errorMessage: null,
    };
  }

  // Audience growth (2026-08-17) — same endpoint already used for the
  // connect-time display-name lookup above, needs no additional scope
  // beyond the read:accounts already granted.
  async getFollowerCount(accessToken: string): Promise<number | null> {
    const res = await fetch(`${DEFAULT_INSTANCE}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[mastodon] getFollowerCount failed: HTTP ${res.status} ${body.slice(0, 500)}`);
      return null;
    }
    const json = (await res.json().catch(() => ({}))) as MastodonAccount;
    return json.followers_count ?? null;
  }
}
