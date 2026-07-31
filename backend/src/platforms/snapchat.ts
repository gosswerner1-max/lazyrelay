import { randomBytes, createCipheriv } from "node:crypto";
import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
} from "./types.js";

// Built 2026-07-31 against developers.snap.com's live Public Profile API docs
// (verified via WebFetch, not assumed from training data) — but this adapter
// has NEVER been tested against a real Snapchat account, unlike every other
// adapter in this directory. No OAuth app has been created yet (Business
// Manager setup was paused mid-way — see
// lazyrelay/project-snapchat-replaces-reddit-2026-07-30 memory), and the
// Public Profile API is allowlist-only: even once an app exists, Snap has to
// manually allowlist the client ID before any of this can actually run.
// Treat every endpoint/field below as "best current reading of the docs,"
// not confirmed against a real API response — re-verify against
// developers.snap.com before the first real test once credentials exist.

const AUTHORIZE_URL = "https://accounts.snapchat.com/login/oauth2/authorize";
const TOKEN_URL = "https://accounts.snapchat.com/login/oauth2/access_token";
const API_BASE = "https://businessapi.snapchat.com/v1";
const SCOPE = "snapchat-profile-api";

// Real, confirmed constraint (not shared by any other adapter here): the
// Public Profile API's Story/Spotlight endpoints both require MP4 video —
// there is no documented path for posting a static image directly. Rather
// than guess whether Saved Story's snap_sources would silently accept an
// IMAGE-type media_id (never confirmed against a real response), post()
// honestly rejects non-video content, the same pattern Pinterest's adapter
// uses for video Pins it can't yet build.
const MIN_DURATION_SECONDS = 5;
const MAX_DURATION_SECONDS = 60;

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v)(\?.*)?$/i.test(url);
}

interface SnapchatTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

interface SnapchatErrorBody {
  message?: string;
  error_description?: string;
}

interface SnapchatMyProfileResponse {
  public_profiles?: { id?: string; name?: string }[];
}

interface SnapchatMediaCreateResponse {
  media?: { media_id?: string; add_path?: string; finalize_path?: string };
}

interface SnapchatSavedStoryResponse {
  saved_stories?: { id?: string }[];
  id?: string;
}

export class SnapchatAdapter implements PlatformAdapter {
  readonly platform: "snapchat" = "snapchat";

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: SCOPE,
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    // Docs didn't specify client-auth style (Basic header vs body params) —
    // using body params (client_secret_post), the more common default for
    // OAuth2 authorization_code exchanges. Confirm against a real response
    // once an OAuth app exists; switch to a Basic-auth header if this 401s.
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await res.json()) as SnapchatTokenResponse & SnapchatErrorBody;

    if (!res.ok || !json.access_token) {
      throw new Error(json.error_description ?? json.message ?? "Snapchat token exchange failed");
    }

    // The Public Profile API is scoped per-profile, not per-user — every
    // call needs a profile_id, fetched here so it can be stored as this
    // adapter's platformAccountId (same role Pinterest's username or
    // LinkedIn's member urn plays for other adapters).
    let platformAccountId = "unknown";
    let displayName: string | null = null;
    try {
      const profileRes = await fetch(`${API_BASE}/public_profiles/my_profile`, {
        headers: { Authorization: `Bearer ${json.access_token}` },
      });
      const profileJson = (await profileRes.json()) as SnapchatMyProfileResponse;
      const profile = profileJson.public_profiles?.[0];
      if (profile?.id) {
        platformAccountId = profile.id;
        displayName = profile.name ?? null;
      }
    } catch {
      // Non-fatal — mirrors every other adapter's best-effort display-name
      // lookup pattern. Without a profile_id, post()/verifyPublished() will
      // fail loudly and honestly rather than silently guessing one.
    }

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
      platformAccountId,
      displayName,
    };
  }

  // Media upload is a real architectural outlier versus every other adapter
  // here: Snapchat requires the file itself to be AES-256-CBC encrypted
  // client-side before upload, with the random key/IV sent (base64-encoded)
  // alongside the Create Media Container call. Implemented for files small
  // enough to fit Snapchat's single multipart "part" (up to 32MB) — larger
  // files would need real chunking (part_number 1-35) not built here, since
  // LazyRelay's own /media/upload cap is already well under that.
  private async uploadMedia(profileId: string, accessToken: string, mediaUrl: string): Promise<string> {
    const fileRes = await fetch(mediaUrl);
    if (!fileRes.ok) throw new Error(`Could not fetch media from ${mediaUrl}`);
    const fileBuffer = Buffer.from(await fileRes.arrayBuffer());

    const key = randomBytes(32);
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    const encrypted = Buffer.concat([cipher.update(fileBuffer), cipher.final()]);

    const createRes = await fetch(`${API_BASE}/public_profiles/${profileId}/media`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "VIDEO",
        name: `lazyrelay-${Date.now()}`,
        key: key.toString("base64"),
        iv: iv.toString("base64"),
      }),
    });
    const createJson = (await createRes.json()) as SnapchatMediaCreateResponse & SnapchatErrorBody;
    const media = createJson.media;
    if (!createRes.ok || !media?.media_id || !media.add_path || !media.finalize_path) {
      throw new Error(createJson.message ?? `Snapchat media creation failed (HTTP ${createRes.status})`);
    }

    const uploadForm = new FormData();
    uploadForm.append("action", "ADD");
    uploadForm.append("part_number", "1");
    uploadForm.append("file", new Blob([encrypted]), "media");
    const uploadRes = await fetch(`https://businessapi.snapchat.com${media.add_path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: uploadForm,
    });
    if (!uploadRes.ok) throw new Error(`Snapchat media upload failed (HTTP ${uploadRes.status})`);

    const finalizeRes = await fetch(`https://businessapi.snapchat.com${media.finalize_path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "FINALIZE" }),
    });
    if (!finalizeRes.ok) throw new Error(`Snapchat media finalize failed (HTTP ${finalizeRes.status})`);

    return media.media_id;
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    if (!request.mediaUrl) {
      return { success: false, platformPostId: null, errorMessage: "Snapchat posts require a video file" };
    }
    if (!isVideoUrl(request.mediaUrl)) {
      return {
        success: false,
        platformPostId: null,
        errorMessage:
          `Snapchat's Public Profile API only accepts MP4 video (${MIN_DURATION_SECONDS}-${MAX_DURATION_SECONDS}s) for Stories — image posts aren't supported by this adapter`,
      };
    }

    // profile_id was resolved and stored as platformAccountId at connect
    // time — connect.ts doesn't currently thread that value back into
    // PostRequest (see socialAccountId, LazyRelay's own internal id), so
    // this re-derives it fresh the same way LinkedIn/Threads re-derive their
    // own platform identifiers inside post()/verifyPublished() rather than
    // needing a new field on the shared interface.
    let profileId: string;
    try {
      const profileRes = await fetch(`${API_BASE}/public_profiles/my_profile`, {
        headers: { Authorization: `Bearer ${request.accessToken}` },
      });
      const profileJson = (await profileRes.json()) as SnapchatMyProfileResponse;
      const id = profileJson.public_profiles?.[0]?.id;
      if (!id) throw new Error("no profile id returned");
      profileId = id;
    } catch (err) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: `Could not resolve Snapchat profile id: ${err instanceof Error ? err.message : err}`,
      };
    }

    let mediaId: string;
    try {
      mediaId = await this.uploadMedia(profileId, request.accessToken, request.mediaUrl);
    } catch (err) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: err instanceof Error ? err.message : "Snapchat media upload failed",
      };
    }

    const res = await fetch(`${API_BASE}/public_profiles/${profileId}/saved_stories`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        saved_stories: [
          {
            title: request.content.slice(0, 45),
            snap_sources: [{ media_id: mediaId }],
          },
        ],
      }),
    });
    const json = (await res.json()) as SnapchatSavedStoryResponse & SnapchatErrorBody;
    const savedStoryId = json.saved_stories?.[0]?.id ?? json.id;

    if (!res.ok || !savedStoryId) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: json.message ?? `Snapchat Saved Story creation failed (HTTP ${res.status})`,
      };
    }

    return { success: true, platformPostId: `${profileId}:${savedStoryId}`, errorMessage: null };
  }

  // platformPostId is stored as "profileId:savedStoryId" (see post()) since
  // the Saved Story lookup endpoint is scoped under the profile, not global.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const [profileId, savedStoryId] = platformPostId.split(":");
    if (!profileId || !savedStoryId) {
      return { verifiedLive: false, platformPostUrl: null, errorMessage: "Malformed Snapchat platformPostId" };
    }

    const res = await fetch(`${API_BASE}/public_profiles/${profileId}/saved_stories/${savedStoryId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      return {
        verifiedLive: false,
        platformPostUrl: null,
        errorMessage: `Snapchat Saved Story verification failed (HTTP ${res.status})`,
      };
    }

    return {
      verifiedLive: true,
      // Snap's docs don't document a public web URL format for a Saved
      // Story the way most other platforms do — leaving this null rather
      // than guessing a URL shape that's never been confirmed to resolve.
      platformPostUrl: null,
      errorMessage: null,
    };
  }
}
