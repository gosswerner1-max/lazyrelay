import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
} from "./types.js";
import { fetchMediaForStreaming, createStreamCursor, createChunkStream, type RequestInitWithDuplex } from "./streamUpload.js";

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

// TikTok's real per-chunk ceiling (developers.tiktok.com/doc/content-posting-api-media-transfer-guide,
// confirmed live 2026-09-05): a chunk may be up to 64MB, and a video under
// 5MB must go up as one whole "chunk" too (chunk_size === video_size). So
// ANY video from 0 to 64MB can be sent as a single chunk_size=video_size,
// total_chunk_count=1 request; above 64MB, real sequential multi-chunk
// upload is required (see post() below, built 2026-09-05 alongside the
// app-wide cap raise to 1GB). Previously this was wrongly treated as a hard
// ceiling with no chunking above it (a 5MB-then-64MB single-request-only
// misreading) -- fine while LazyRelay's own app-wide cap was 45MB (always
// under 64MB), but would have silently broken the moment that cap was
// raised, which is exactly why the real chunking loop was built at the same
// time as the cap increase rather than after.
const SINGLE_CHUNK_MAX_BYTES = 64 * 1024 * 1024;

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
    // TikTok's Content Sharing Guidelines require our own UI to show this
    // choice with no default selection -- a missing value here means the
    // customer never made that choice (or an old row predates this field),
    // not something the adapter should silently default. See the comment on
    // PostRequest.tiktokPrivacyLevel and migration 0083.
    if (!request.tiktokPrivacyLevel) {
      return { success: false, platformPostId: null, errorMessage: "TikTok posts require a privacy level to be chosen" };
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
    const media = await fetchMediaForStreaming(request.mediaUrl);
    if (!media) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: "Failed to fetch video from storage for upload",
      };
    }
    if (media.sizeBytes == null) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: "Could not determine video size from storage (missing Content-Length) — cannot build a TikTok chunk plan without a known size",
      };
    }
    const videoSize = media.sizeBytes;

    // Real multi-chunk upload above TikTok's 64MB single-PUT ceiling, built
    // 2026-09-05 alongside the app-wide cap raise to 1GB -- raising the cap
    // without this would have silently reintroduced the exact bug already
    // found and fixed once today (mediaLimits.ts approving a video this
    // adapter then can't actually send).
    //
    // CAUGHT LIVE 2026-09-05 during the real test pass, before this ever
    // reached TikTok: choosing chunkSize = min(videoSize, 64MB) and then
    // total_chunk_count = floor(videoSize/chunkSize) is WRONG whenever
    // videoSize is just over 64MB -- e.g. an 83MB video gives
    // chunkSize=64MB, floor(83/64)=1, meaning "1 chunk" for a video TikTok's
    // own docs say "must be uploaded in multiple chunks" once over 64MB.
    // The fix: pick the SMALLEST chunk count N that keeps every chunk at or
    // under 64MB (N = ceil(videoSize / 64MB)), then set chunkSize =
    // floor(videoSize / N) -- choosing chunkSize this way (not by simply
    // capping at 64MB) is what makes TikTok's own floor-division formula
    // land on exactly N chunks, with the last chunk absorbing only the
    // small remainder floor() leaves over (well under the 128MB final-chunk
    // allowance), rather than ballooning back up to the whole file.
    // developers.tiktok.com/doc/content-posting-api-media-transfer-guide,
    // confirmed live 2026-09-05: "at least 5 MB but no greater than 64 MB,
    // except for the final chunk, which can be greater... (up to 128 MB)",
    // "total_chunk_count ... equal to video_size divided by chunk_size,
    // rounded down", "chunks must be uploaded sequentially."
    let chunkSize: number;
    let totalChunkCount: number;
    if (videoSize <= SINGLE_CHUNK_MAX_BYTES) {
      chunkSize = videoSize;
      totalChunkCount = 1;
    } else {
      const chunkCountNeeded = Math.ceil(videoSize / SINGLE_CHUNK_MAX_BYTES);
      chunkSize = Math.floor(videoSize / chunkCountNeeded);
      totalChunkCount = Math.floor(videoSize / chunkSize);
    }

    const res = await fetch(POST_INIT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        post_info: {
          // A real customer choice now (2026-09-05), not hardcoded -- see
          // PostRequest.tiktokPrivacyLevel. While this app remains
          // unaudited with TikTok, only SELF_ONLY will actually succeed
          // regardless of what's requested here (confirmed via the real API
          // error unaudited_client_can_only_post_to_private_accounts) --
          // that's TikTok's own account-level restriction, not something
          // this adapter enforces.
          privacy_level: request.tiktokPrivacyLevel,
          title: request.content.slice(0, 2200),
          disable_duet: request.tiktokDisableDuet ?? true,
          disable_stitch: request.tiktokDisableStitch ?? true,
          disable_comment: request.tiktokDisableComment ?? true,
          // Commercial-content disclosure (2026-09-05) -- see
          // PostRequest.tiktokBrandOrganic and migration 0084. Both default
          // false, matching TikTok's own "off by default" requirement.
          brand_organic_toggle: request.tiktokBrandOrganic ?? false,
          brand_content_toggle: request.tiktokBrandContent ?? false,
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: videoSize,
          chunk_size: chunkSize,
          total_chunk_count: totalChunkCount,
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

    // Chunks must be uploaded sequentially (TikTok's own requirement) --
    // one shared cursor over the single source stream, each chunk's PUT
    // consuming exactly its own byte range before the next one starts, so
    // memory never holds more than one underlying read()'s worth of data
    // regardless of total video size. See streamUpload.ts's
    // createChunkStream for how a continuous stream gets split this way.
    const cursor = createStreamCursor(media.body);
    for (let i = 0; i < totalChunkCount; i++) {
      const start = i * chunkSize;
      // Last chunk absorbs the remainder (including TikTok's own floor
      // division leaving bytes unaccounted for) -- matches
      // video_size/chunk_size/total_chunk_count semantics from the init
      // call above.
      const end = i === totalChunkCount - 1 ? videoSize - 1 : start + chunkSize - 1;
      const thisChunkBytes = end - start + 1;
      const chunkStream = createChunkStream(cursor, thisChunkBytes);
      const uploadRes = await fetch(json.data.upload_url, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(thisChunkBytes),
          "Content-Range": `bytes ${start}-${end}/${videoSize}`,
        },
        body: chunkStream,
        duplex: "half",
      } as RequestInitWithDuplex);
      if (!uploadRes.ok) {
        return {
          success: false,
          platformPostId: json.data.publish_id,
          errorMessage: `TikTok video upload failed on chunk ${i + 1}/${totalChunkCount} (HTTP ${uploadRes.status})`,
        };
      }
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
