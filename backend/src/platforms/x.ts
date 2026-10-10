// X (Twitter), "bring your own key" only (Werner, 2026-10-10). LazyRelay has no X app of its own: the customer creates
// an X developer app, pays X for its use, and pastes the four OAuth 1.0a values (API Key, API Secret, Access Token,
// Access Token Secret). They are stored as ONE JSON string in the connection's Vault secret (see xByok.ts) and arrive
// here as the "access token" string on every call. Each call parses that bundle and signs its own request
// (RFC 5849 HMAC-SHA1, oauth1.ts); nothing is cached, logged or put in an error.
//
// There is no OAuth redirect, no refresh and no corporate X credential: getAuthorizeUrl and exchangeCode exist only
// because the PlatformAdapter interface requires them, and the connection is made through POST
// /social-accounts/x/byok (http/routes/xByok.routes.ts). A connection whose stored login is not a valid bundle fails
// with the fixed "does not use your own keys" reason (postErrors.ts) instead of sending anything to X.

import { fetchMediaForStreaming } from "./streamUpload.js";
import type { PlatformAdapter, PostRequest, PostAttemptResult, VerifyResult, OAuthExchangeResult, PostMetrics } from "./types.js";
import { createXSignedFetch, describeXFailure, readJson, X_API_BASE, type XSignedFetch } from "./xApi.js";
import { createXMediaUploader, X_MEDIA_UPLOAD_CONFIG, type XMediaFlow, type XMediaUploaderOptions } from "./xMedia.js";
import { parseXBundle, X_BUNDLE_INVALID_CODE, type XByokBundle } from "./xByok.js";

const TWEETS_URL = `${X_API_BASE}/2/tweets`;
const ME_URL = `${X_API_BASE}/2/users/me`;

const CONNECT_ELSEWHERE = "X is connected with your own developer keys from Social Platforms, not through a sign-in redirect.";

export type XKeyCheck =
  | { ok: true; id: string; username: string; name: string | null }
  | { ok: false; reason: "invalid" | "out_of_credit" | "forbidden" | "rate_limited" | "unreachable" };

interface XTweetResponse {
  data?: { id?: string; text?: string };
}
interface XUserResponse {
  data?: { id?: string; username?: string; name?: string };
}
interface XTweetMetricsResponse {
  data?: {
    id?: string;
    public_metrics?: { like_count?: number; reply_count?: number; retweet_count?: number; impression_count?: number };
  };
}

export interface XAdapterOptions {
  /** Which media flow to use. Defaults to X_MEDIA_UPLOAD_CONFIG.flow in xMedia.ts. */
  mediaFlow?: XMediaFlow;
  /** Passed to the media uploader (tests use an instant sleep). */
  media?: Pick<XMediaUploaderOptions, "sleep" | "config">;
}

export class XAdapter implements PlatformAdapter {
  readonly platform: "x" = "x";
  readonly byok = true;
  /** The customer typed the account themselves: there is nothing to confirm after the keys check out. */
  readonly skipConnectConfirmation = true;

  constructor(private readonly options: XAdapterOptions = {}) {}

  async getAuthorizeUrl(): Promise<string> {
    throw new Error(CONNECT_ELSEWHERE);
  }

  async exchangeCode(): Promise<OAuthExchangeResult> {
    throw new Error(CONNECT_ELSEWHERE);
  }

  private signedFor(bundle: XByokBundle): XSignedFetch {
    return createXSignedFetch(bundle);
  }

  /** Proves all four values with a signed GET /2/users/me and returns the account they belong to. Used by the keys
   *  route; the result never carries X's body or any value. */
  async verifyKeys(bundle: XByokBundle): Promise<XKeyCheck> {
    let res: Response;
    try {
      res = await this.signedFor(bundle)({ method: "GET", url: ME_URL });
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    const json = (await readJson(res)) as XUserResponse | null;
    if (res.ok && json?.data?.id && json.data.username) {
      return { ok: true, id: json.data.id, username: json.data.username, name: json.data.name ?? null };
    }
    const text = describeXFailure(res, json, bundle);
    if (res.status === 402 || /credit|usage-capped|spending limit/i.test(text)) return { ok: false, reason: "out_of_credit" };
    if (res.status === 401) return { ok: false, reason: "invalid" };
    if (res.status === 403) return { ok: false, reason: "forbidden" };
    if (res.status === 429) return { ok: false, reason: "rate_limited" };
    return { ok: false, reason: res.status >= 500 ? "unreachable" : "invalid" };
  }

  private async uploadMedia(mediaUrl: string, bundle: XByokBundle): Promise<{ mediaId: string } | { error: string }> {
    // fetchMediaForStreaming re-checks the URL (SSRF guard) at the fetch point, like every other adapter. The whole
    // file is buffered because chunked upload needs the total size up front.
    const media = await fetchMediaForStreaming(mediaUrl);
    if (!media) return { error: `Could not upload media from ${mediaUrl}` };
    const bytes = Buffer.from(await new Response(media.body).arrayBuffer());
    const uploader = createXMediaUploader(this.options.mediaFlow ?? X_MEDIA_UPLOAD_CONFIG.flow, bundle, this.options.media);
    const result = await uploader.upload({ bytes, mimeType: media.contentType });
    if (!result.ok) return { error: `Could not upload media from ${mediaUrl}: ${result.errorMessage}` };
    return { mediaId: result.mediaId };
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const bundle = parseXBundle(request.accessToken);
    if (!bundle) return { success: false, platformPostId: null, errorMessage: X_BUNDLE_INVALID_CODE };

    const mediaIds: string[] = [];
    if (request.mediaUrl) {
      for (const url of [request.mediaUrl, ...(request.mediaUrls ?? [])]) {
        const uploaded = await this.uploadMedia(url, bundle);
        if ("error" in uploaded) return { success: false, platformPostId: null, errorMessage: uploaded.error };
        mediaIds.push(uploaded.mediaId);
      }
    }

    let res: Response;
    try {
      res = await this.signedFor(bundle)({
        method: "POST",
        url: TWEETS_URL,
        json: { text: request.content, ...(mediaIds.length > 0 ? { media: { media_ids: mediaIds } } : {}) },
      });
    } catch {
      return { success: false, platformPostId: null, errorMessage: "X post creation failed (could not reach X)" };
    }
    const json = (await readJson(res)) as XTweetResponse | null;
    if (!res.ok || !json?.data?.id) {
      return { success: false, platformPostId: null, errorMessage: describeXFailure(res, json, bundle) };
    }
    return { success: true, platformPostId: json.data.id, errorMessage: null };
  }

  // Thread chains: POST /2/tweets with reply.in_reply_to_tweet_id = the previous tweet's id.
  async postChainReply(input: {
    rootPostId: string;
    parentPostId: string;
    text: string;
    accessToken: string;
    platformAccountId?: string | null;
  }): Promise<{ success: boolean; platformPostId: string | null; errorMessage: string | null }> {
    const bundle = parseXBundle(input.accessToken);
    if (!bundle) return { success: false, platformPostId: null, errorMessage: X_BUNDLE_INVALID_CODE };
    let res: Response;
    try {
      res = await this.signedFor(bundle)({
        method: "POST",
        url: TWEETS_URL,
        json: { text: input.text, reply: { in_reply_to_tweet_id: input.parentPostId } },
      });
    } catch {
      return { success: false, platformPostId: null, errorMessage: "X thread reply failed (could not reach X)" };
    }
    const json = (await readJson(res)) as XTweetResponse | null;
    if (!res.ok || !json?.data?.id) {
      return { success: false, platformPostId: null, errorMessage: describeXFailure(res, json, bundle) };
    }
    return { success: true, platformPostId: json.data.id, errorMessage: null };
  }

  // Real independent Proof-of-Publish check: GET the tweet back by id rather than trusting post()'s response.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const bundle = parseXBundle(accessToken);
    if (!bundle) return { verifiedLive: false, platformPostUrl: null, errorMessage: X_BUNDLE_INVALID_CODE };
    let res: Response;
    try {
      res = await this.signedFor(bundle)({ method: "GET", url: `${TWEETS_URL}/${encodeURIComponent(platformPostId)}` });
    } catch {
      return { verifiedLive: false, platformPostUrl: null, errorMessage: "X post verification failed (could not reach X)" };
    }
    const json = (await readJson(res)) as XTweetResponse | null;
    if (!res.ok || json?.data?.id !== platformPostId) {
      return { verifiedLive: false, platformPostUrl: null, errorMessage: describeXFailure(res, json, bundle) };
    }
    return { verifiedLive: true, platformPostUrl: `https://x.com/i/status/${platformPostId}`, errorMessage: null };
  }

  // public_metrics includes an impression_count, unlike most platforms, so X can report a real `views` number.
  async getPostMetrics(platformPostId: string, accessToken: string): Promise<PostMetrics> {
    const none = (errorMessage: string): PostMetrics => ({ likes: null, comments: null, shares: null, views: null, errorMessage });
    const bundle = parseXBundle(accessToken);
    if (!bundle) return none(X_BUNDLE_INVALID_CODE);
    const url = new URL(`${TWEETS_URL}/${encodeURIComponent(platformPostId)}`);
    url.searchParams.set("tweet.fields", "public_metrics");
    let res: Response;
    try {
      res = await this.signedFor(bundle)({ method: "GET", url: url.toString() });
    } catch {
      return none("Could not load metrics (could not reach X)");
    }
    const json = (await readJson(res)) as XTweetMetricsResponse | null;
    if (!res.ok || !json?.data?.id) return none(describeXFailure(res, json, bundle));
    const m = json.data.public_metrics ?? {};
    return {
      likes: m.like_count ?? null,
      comments: m.reply_count ?? null,
      shares: m.retweet_count ?? null,
      views: m.impression_count ?? null,
      errorMessage: null,
    };
  }
}
