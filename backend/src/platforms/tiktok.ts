import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
} from "./types.js";

const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USER_INFO_URL = "https://open.tiktokapis.com/v2/user/info/";
const CREATOR_INFO_URL = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const POST_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const POST_STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

// video.publish is the Content Posting API scope; user.info.basic lets us
// show a real display name instead of just the opaque open_id.
const SCOPES = "user.info.basic,video.publish";

// Polling budget for the async publish flow — see the comment on
// verifyPublished() for why this exists and its known limitation.
const STATUS_POLL_ATTEMPTS = 5;
const STATUS_POLL_DELAY_MS = 3000;

interface TikTokTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  open_id?: string;
  error?: string;
  error_description?: string;
}

interface TikTokApiEnvelope<T> {
  data?: T;
  error?: { code: string; message: string; log_id?: string };
}

interface CreatorInfo {
  privacy_level_options?: string[];
}

// TikTok's own single-chunk exception: files under 5MB may be uploaded as
// one chunk (chunk_size === video_size, total_chunk_count === 1) instead of
// being split into 5-64MB chunks.
const SINGLE_CHUNK_MAX_BYTES = 5 * 1024 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TikTokAdapter implements PlatformAdapter {
  readonly platform: "tiktok" = "tiktok";

  constructor(
    private readonly clientKey: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({
      client_key: this.clientKey,
      scope: SCOPES,
      response_type: "code",
      redirect_uri: this.redirectUri,
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    const body = new URLSearchParams({
      client_key: this.clientKey,
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
    const json = (await res.json()) as TikTokTokenResponse;

    if (!res.ok || !json.access_token || !json.open_id) {
      throw new Error(json.error_description ?? json.error ?? "TikTok token exchange failed");
    }

    // Best-effort display name lookup — a failure here shouldn't block the
    // connect flow, since open_id alone is enough to identify the account.
    let displayName: string | null = null;
    try {
      const userRes = await fetch(`${USER_INFO_URL}?fields=display_name`, {
        headers: { Authorization: `Bearer ${json.access_token}` },
      });
      const userJson = (await userRes.json()) as TikTokApiEnvelope<{ user?: { display_name?: string } }>;
      displayName = userJson.data?.user?.display_name ?? null;
    } catch {
      // Non-fatal — see comment above.
    }

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
      platformAccountId: json.open_id,
      displayName,
    };
  }

  // TikTok access tokens are short-lived (~24h) — confirmed live, not just
  // from docs: a connection made 2026-08-03 had a dead access token by
  // 2026-08-06 with "The access token is invalid or not found in the
  // request." Refresh tokens are captured at connect time (exchangeCode
  // above) but were never used anywhere until this method existed.
  // grant_type=refresh_token is TikTok's documented rotation flow — same
  // token endpoint, and per their docs the refresh token itself also
  // rotates on use, so the caller must persist the new refresh_token too,
  // not just the new access_token.
  async refresh(refreshToken: string): Promise<OAuthExchangeResult> {
    const body = new URLSearchParams({
      client_key: this.clientKey,
      client_secret: this.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await res.json()) as TikTokTokenResponse;

    if (!res.ok || !json.access_token || !json.open_id) {
      throw new Error(json.error_description ?? json.error ?? "TikTok token refresh failed");
    }

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
      platformAccountId: json.open_id,
      displayName: null,
    };
  }

  // Real TikTok accounts can have Direct Post unavailable to them entirely —
  // confirmed via TikTok's own docs, not assumed: certain account
  // types/regions/settings return no usable privacy_level_options at all.
  // Checking this first turns that into one clear, honest error instead of
  // a raw/cryptic failure from the post-init call itself. Uses the
  // video.publish scope this adapter already requests — no new scope
  // needed. Deliberately does NOT fall back to TikTok's draft/inbox upload
  // (video.upload) on failure here: that would hand the customer an
  // unfinished draft they'd have to open TikTok and complete by hand, a
  // worse promise than "this account can't be posted to directly" — see
  // project-platform-review-status-check-2026-08-04.md for why that
  // fallback was deliberately rejected. This is a genuine TikTok-side
  // restriction outside LazyRelay's control (documented for customers via
  // the Terms of Service), not a bug to work around.
  private async checkDirectPostEligible(accessToken: string): Promise<{ eligible: boolean; errorMessage: string | null }> {
    const res = await fetch(CREATOR_INFO_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
    });
    const json = (await res.json()) as TikTokApiEnvelope<CreatorInfo>;

    if (!res.ok || !json.data) {
      // Can't confirm eligibility either way — fail open rather than block
      // a post over a diagnostic call hiccup; the real post-init call below
      // will surface any genuine problem on its own.
      return { eligible: true, errorMessage: null };
    }

    const options = json.data.privacy_level_options ?? [];
    if (!options.includes("SELF_ONLY")) {
      return {
        eligible: false,
        errorMessage:
          "TikTok does not allow direct posting for this account. This is a restriction TikTok applies at the account or region level, not something LazyRelay controls — see our Terms of Service.",
      };
    }
    return { eligible: true, errorMessage: null };
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    if (!request.mediaUrl) {
      return { success: false, platformPostId: null, errorMessage: "TikTok posts require a video URL" };
    }

    const eligibility = await this.checkDirectPostEligible(request.accessToken);
    if (!eligibility.eligible) {
      return { success: false, platformPostId: null, errorMessage: eligibility.errorMessage };
    }

    // FILE_UPLOAD instead of PULL_FROM_URL: pull-by-url requires the video's
    // domain to be added to TikTok's "Verified domains" for the Content
    // Posting API. Our media is served from Supabase storage
    // (*.supabase.co) — a shared domain we don't control the DNS for and
    // can never verify — so pull-by-url would fail for every post, not just
    // this one. Uploading the bytes directly sidesteps domain verification
    // entirely.
    // redirect: "manual" — see mastodon.ts's uploadMedia for the full
    // rationale (closes the adapter-side redirect-following SSRF gap).
    const videoRes = await fetch(request.mediaUrl, { redirect: "manual" });
    if (!videoRes.ok) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: `Failed to fetch video from storage for upload (HTTP ${videoRes.status})`,
      };
    }
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
    const videoSize = videoBuffer.byteLength;

    const res = await fetch(POST_INIT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        post_info: {
          // Hardcoded SELF_ONLY: this app is still in Sandbox / unaudited
          // with TikTok (Content Posting API review pending — see
          // project-platform-app-registration memory). Unaudited clients
          // are only permitted to publish as SELF_ONLY; requesting anything
          // else here would be rejected by TikTok outright. Switch this to
          // a real customer-facing choice once TikTok's app audit clears.
          privacy_level: "SELF_ONLY",
          title: request.content.slice(0, 2200),
          disable_duet: false,
          disable_stitch: false,
          disable_comment: false,
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: videoSize,
          // Files under 5MB go up as a single chunk (TikTok's own documented
          // exception to the normal 5-64MB chunk range) — true for every
          // video this app generates today. A genuinely large upload would
          // need real chunking here.
          chunk_size: videoSize,
          total_chunk_count: 1,
        },
      }),
    });
    const json = (await res.json()) as TikTokApiEnvelope<{ publish_id?: string; upload_url?: string }>;

    if (!res.ok || !json.data?.publish_id || !json.data?.upload_url) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: json.error?.message ?? `TikTok post init failed (HTTP ${res.status})`,
      };
    }

    if (videoSize > SINGLE_CHUNK_MAX_BYTES) {
      return {
        success: false,
        platformPostId: json.data.publish_id,
        errorMessage: `Video is ${videoSize} bytes — single-chunk upload only supports files under ${SINGLE_CHUNK_MAX_BYTES} bytes`,
      };
    }

    const uploadRes = await fetch(json.data.upload_url, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes 0-${videoSize - 1}/${videoSize}`,
      },
      body: videoBuffer,
    });
    if (!uploadRes.ok) {
      return {
        success: false,
        platformPostId: json.data.publish_id,
        errorMessage: `TikTok video upload failed (HTTP ${uploadRes.status})`,
      };
    }

    return { success: true, platformPostId: json.data.publish_id, errorMessage: null };
  }

  // TikTok's publish is asynchronous — status moves through
  // PROCESSING_DOWNLOAD/PROCESSING_UPLOAD before PUBLISH_COMPLETE (or
  // FAILED). The scheduler calls verifyPublished() immediately after
  // post() with no separate "pending verification" state, so this polls
  // status/fetch for a bounded window rather than checking once. If
  // TikTok is still processing after that window, this returns
  // verifiedLive: false, which sends the post through the scheduler's
  // normal retry path — but a retry re-runs post() from scratch, which
  // would create a duplicate publish_id for content TikTok is still
  // working on. This is a known gap or short videos it should rarely
  // trigger in practice; a real fix needs a distinct "pending verification"
  // state on scheduled_posts rather than reusing the post-retry path.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt++) {
      const res = await fetch(POST_STATUS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ publish_id: platformPostId }),
      });
      const json = (await res.json()) as TikTokApiEnvelope<{
        status?: string;
        fail_reason?: string;
        publicaly_available_post_id?: string[];
      }>;

      if (!res.ok || !json.data) {
        return {
          verifiedLive: false,
          platformPostUrl: null,
          errorMessage: json.error?.message ?? `TikTok status check failed (HTTP ${res.status})`,
        };
      }

      if (json.data.status === "PUBLISH_COMPLETE") {
        // publicaly_available_post_id is only ever populated for public
        // (non-SELF_ONLY) posts that passed moderation — always empty for
        // the SELF_ONLY posts this adapter currently creates (see post()).
        const publicId = json.data.publicaly_available_post_id?.[0] ?? null;
        return {
          verifiedLive: true,
          platformPostUrl: publicId ? `https://www.tiktok.com/@_/video/${publicId}` : null,
          errorMessage: null,
        };
      }
      if (json.data.status === "FAILED") {
        return {
          verifiedLive: false,
          platformPostUrl: null,
          errorMessage: json.data.fail_reason ?? "TikTok reported the post failed",
        };
      }

      // PROCESSING_DOWNLOAD / PROCESSING_UPLOAD / SEND_TO_USER_INBOX — keep polling.
      if (attempt < STATUS_POLL_ATTEMPTS - 1) await sleep(STATUS_POLL_DELAY_MS);
    }

    return {
      verifiedLive: false,
      platformPostUrl: null,
      errorMessage: "TikTok is still processing this post — verification timed out",
    };
  }
}
