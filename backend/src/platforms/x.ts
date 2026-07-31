import { randomBytes, createHash } from "node:crypto";
import { supabase } from "../supabase.js";
import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
} from "./types.js";

// X's OAuth 2.0 Authorization Code flow is PKCE-only — even a confidential
// (client-secret-holding) app must send a code_challenge, unlike every other
// adapter in this codebase. The verifier is generated here and stashed on
// the oauth_states row (see 0023_x_platform.sql) since getAuthorizeUrl only
// returns a URL, not a value connect.ts could hold onto itself.
const AUTHORIZE_URL = "https://twitter.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const TWEETS_URL = "https://api.twitter.com/2/tweets";
const ME_URL = "https://api.twitter.com/2/users/me";
const MEDIA_UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json";

const SCOPES = "tweet.read tweet.write users.read offline.access";

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface XTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface XUserResponse {
  data?: { id?: string; username?: string };
  errors?: { message?: string }[];
}

interface XTweetResponse {
  data?: { id?: string; text?: string };
  errors?: { message?: string }[];
}

interface XMediaUploadResponse {
  media_id_string?: string;
  errors?: { message?: string }[];
}

export class XAdapter implements PlatformAdapter {
  readonly platform: "x" = "x";

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  async getAuthorizeUrl(state: string): Promise<string> {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());

    // state is already a real oauth_states row id (created by
    // connect.ts before this is called) — updating it in place is safe,
    // there's no race with the row's own creation.
    const { error } = await supabase.from("oauth_states").update({ pkce_verifier: verifier }).eq("id", state);
    if (error) throw error;

    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string, pkceVerifier?: string): Promise<OAuthExchangeResult> {
    if (!pkceVerifier) {
      throw new Error("X connect flow lost its PKCE verifier — please try connecting again");
    }

    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      code_verifier: pkceVerifier,
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const json = (await res.json()) as XTokenResponse;
    if (!res.ok || !json.access_token) {
      throw new Error(json.error_description ?? json.error ?? "X token exchange failed");
    }

    let displayName: string | null = null;
    let platformAccountId = "unknown";
    try {
      const meRes = await fetch(ME_URL, { headers: { Authorization: `Bearer ${json.access_token}` } });
      const meJson = (await meRes.json()) as XUserResponse;
      if (meJson.data?.id) {
        platformAccountId = meJson.data.id;
        displayName = meJson.data.username ?? null;
      }
    } catch {
      // Best-effort — non-fatal, same pattern as every other adapter's
      // display-name lookup.
    }

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
      platformAccountId,
      displayName,
    };
  }

  // v1.1 chunked media upload — the only media-upload endpoint X exposes;
  // there is still no v2 equivalent. Confirmed live in X's own docs that
  // this endpoint accepts an OAuth 2.0 user-context Bearer token, not just
  // OAuth 1.0a, despite living under the legacy /1.1/ path.
  private async uploadMedia(mediaUrl: string, accessToken: string): Promise<string | null> {
    const mediaRes = await fetch(mediaUrl);
    if (!mediaRes.ok || !mediaRes.body) return null;
    const buffer = Buffer.from(await mediaRes.arrayBuffer());
    const mimeType = mediaRes.headers.get("content-type") ?? "application/octet-stream";
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    const initParams = new URLSearchParams({
      command: "INIT",
      total_bytes: String(buffer.length),
      media_type: mimeType,
    });
    const initRes = await fetch(`${MEDIA_UPLOAD_URL}?${initParams.toString()}`, {
      method: "POST",
      headers: authHeader,
    });
    const initJson = (await initRes.json()) as XMediaUploadResponse;
    if (!initRes.ok || !initJson.media_id_string) return null;
    const mediaId = initJson.media_id_string;

    const form = new FormData();
    form.append("command", "APPEND");
    form.append("media_id", mediaId);
    form.append("segment_index", "0");
    form.append("media", new Blob([buffer]));
    const appendRes = await fetch(MEDIA_UPLOAD_URL, { method: "POST", headers: authHeader, body: form });
    if (!appendRes.ok) return null;

    const finalizeParams = new URLSearchParams({ command: "FINALIZE", media_id: mediaId });
    const finalizeRes = await fetch(`${MEDIA_UPLOAD_URL}?${finalizeParams.toString()}`, {
      method: "POST",
      headers: authHeader,
    });
    if (!finalizeRes.ok) return null;

    return mediaId;
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    let mediaId: string | null = null;
    if (request.mediaUrl) {
      mediaId = await this.uploadMedia(request.mediaUrl, request.accessToken);
      if (!mediaId) {
        return { success: false, platformPostId: null, errorMessage: `Could not upload media from ${request.mediaUrl}` };
      }
    }

    const res = await fetch(TWEETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: request.content,
        ...(mediaId ? { media: { media_ids: [mediaId] } } : {}),
      }),
    });
    const json = (await res.json()) as XTweetResponse;

    if (!res.ok || !json.data?.id) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: json.errors?.[0]?.message ?? `X post creation failed (HTTP ${res.status})`,
      };
    }

    return { success: true, platformPostId: json.data.id, errorMessage: null };
  }

  // Real independent Proof-of-Publish check: GET the tweet back by id
  // rather than trusting post()'s response, per the discipline every other
  // adapter follows.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const res = await fetch(`${TWEETS_URL}/${platformPostId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json()) as XTweetResponse;

    if (!res.ok || json.data?.id !== platformPostId) {
      return {
        verifiedLive: false,
        platformPostUrl: null,
        errorMessage: json.errors?.[0]?.message ?? `X post verification failed (HTTP ${res.status})`,
      };
    }

    return {
      verifiedLive: true,
      platformPostUrl: `https://x.com/i/status/${platformPostId}`,
      errorMessage: null,
    };
  }
}
