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
import { fetchMediaForStreaming, buildStreamingMultipartBody, type RequestInitWithDuplex } from "./streamUpload.js";
import { CustomerHostError, guardedFetch, normalizeHostOrigin, readJsonCapped, UPLOAD_TIMEOUT_MS } from "./customerHost.js";
import { deleteMastodonApp, loadMastodonApp, saveMastodonApp } from "./mastodonApps.js";
import { randomUUID } from "node:crypto";

// Real, confirmed platform gotcha: Mastodon is decentralized — every
// instance (mastodon.social, hachyderm.io, ...) is its own OAuth server
// with its own app registration.
//
// Two kinds of connected account exist (master list #11):
//   - DEFAULT (mastodon.social): every account connected before instances were
//     customer-chosen, and any new one where the customer leaves the instance blank or
//     types mastodon.social. The stored token is the bare access token string and every
//     request goes straight to DEFAULT_INSTANCE exactly as it always did.
//   - CUSTOM instance: the customer typed another server. The stored token is the JSON
//     {"instance":"https://hachyderm.io","token":"..."} and every request goes through
//     customerHost.ts (SSRF guard, pinned connection, no redirects, capped reads,
//     timeouts), because the host is customer-supplied.
// parseMastodonCredentials() below is the single place that tells the two apart; every
// method of this adapter starts with it.
const DEFAULT_INSTANCE = "https://mastodon.social";

export interface MastodonCredentials {
  /** https origin the account lives on, no trailing slash. */
  origin: string;
  token: string;
  /** True for mastodon.social: requests use the plain, unguarded path that has always been used. */
  isDefault: boolean;
}

const DAMAGED_MESSAGE = "The saved Mastodon connection is damaged. Reconnect this account.";

/** Accepts "hachyderm.io", "https://hachyderm.io/" or a full handle like "@me@hachyderm.io". */
export function normalizeMastodonInstance(input: string): { ok: true; origin: string; host: string } | { ok: false; error: string } {
  const handle = /^@?[^@/\\\s]+@([^@/\\\s]+)$/.exec(input.trim());
  return normalizeHostOrigin(handle ? handle[1] : input, "Mastodon server", "hachyderm.io");
}

/** Reads what is stored in the vault for a Mastodon account. A bare string is the old format
 *  (an access token on mastodon.social); a string starting with "{" is the new JSON. Real
 *  Mastodon tokens never start with "{". Throws a CustomerHostError (safe message) when the
 *  JSON is unusable. */
export function parseMastodonCredentials(accessToken: string): MastodonCredentials {
  if (!accessToken.startsWith("{")) return { origin: DEFAULT_INSTANCE, token: accessToken, isDefault: true };
  let parsed: { instance?: unknown; token?: unknown };
  try {
    parsed = JSON.parse(accessToken) as typeof parsed;
  } catch {
    throw new CustomerHostError(DAMAGED_MESSAGE);
  }
  if (typeof parsed.instance !== "string" || typeof parsed.token !== "string" || !parsed.token) {
    throw new CustomerHostError(DAMAGED_MESSAGE);
  }
  const norm = normalizeMastodonInstance(parsed.instance);
  if (!norm.ok) throw new CustomerHostError(DAMAGED_MESSAGE);
  return { origin: norm.origin, token: parsed.token, isDefault: norm.origin === DEFAULT_INSTANCE };
}

/** A link a customer-chosen server hands back ends up on a public page, so it is only used when it is
 *  https and on the instance's own host. Anything else (javascript:, another host) is dropped. */
function ownHostUrl(c: MastodonCredentials, candidate: unknown): string | null {
  if (typeof candidate !== "string" || !candidate) return null;
  try {
    const u = new URL(candidate);
    return u.protocol === "https:" && u.hostname.toLowerCase() === new URL(c.origin).hostname ? u.toString() : null;
  } catch {
    return null;
  }
}

// Only a customer's own instance is ever cleaned; mastodon.social keeps the URL the server returns.
function statusLink(c: MastodonCredentials, serverUrl: string | null | undefined, id: string): string | null {
  if (c.isDefault) return serverUrl ?? null;
  return ownHostUrl(c, serverUrl) ?? `${c.origin}/web/statuses/${encodeURIComponent(id)}`;
}

// Video uploads (and sometimes large images) come back 202 "still
// processing" from POST /api/v2/media -- GET /api/v1/media/:id then returns
// 206 until it's ready and 200 once it is. Posting a status with a media_id
// that's still 206 fails every time with "Cannot attach files that have not
// finished processing" (real incident, 2026-09-23: the first-ever Mastodon
// video post), so uploadMedia polls before returning a media_id born from a
// 202 response.
const MEDIA_PROCESSING_TIMEOUT_MS = 60_000;
const MEDIA_PROCESSING_POLL_MS = 3_000;

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
  // platform, this adapter registers itself on first use. mastodon.social is
  // cached for the life of the process only (as it always was); a customer's
  // own instance is also cached in the database (mastodonApps.ts) so a restart
  // or a second backend does not register again.
  private appCredentials: { clientId: string; clientSecret: string } | null = null;
  private readonly customApps = new Map<string, { clientId: string; clientSecret: string }>();

  constructor(private readonly redirectUri: string) {}

  // -------------------------------------------------------------------------------------
  // Request helpers: the default instance keeps the plain fetch it always used; any other
  // instance goes through the customer-host guard.
  // -------------------------------------------------------------------------------------

  private send(c: MastodonCredentials, path: string, init?: RequestInitWithDuplex, timeoutMs?: number): Promise<Response> {
    if (c.isDefault) return fetch(`${DEFAULT_INSTANCE}${path}`, init);
    return guardedFetch(`${c.origin}${path}`, init, timeoutMs);
  }

  private readBody<T>(c: MastodonCredentials, res: Response): Promise<T> {
    if (c.isDefault) return res.json() as Promise<T>;
    return readJsonCapped(res).then((j) => ((j && typeof j === "object" ? j : {}) as T));
  }

  // Text from a customer-chosen server is capped before it is stored or shown.
  private msg(c: MastodonCredentials, fromServer: string | undefined, fallback: string): string {
    if (c.isDefault) return fromServer ?? fallback;
    return fromServer && typeof fromServer === "string" ? fromServer.slice(0, 300) : fallback;
  }

  private async ensureAppRegistered(origin: string): Promise<{ clientId: string; clientSecret: string }> {
    if (origin === DEFAULT_INSTANCE) {
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

    const cached = this.customApps.get(origin);
    if (cached) return cached;
    const stored = await loadMastodonApp(origin, this.redirectUri);
    if (stored) {
      this.customApps.set(origin, stored);
      return stored;
    }

    const res = await guardedFetch(`${origin}/api/v1/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "LazyRelay",
        redirect_uris: this.redirectUri,
        scopes: SCOPES,
        website: "https://lazyrelay.com",
      }),
    });
    const json = ((await readJsonCapped(res)) ?? {}) as MastodonAppCredentials;
    if (!res.ok || typeof json.client_id !== "string" || typeof json.client_secret !== "string" || !json.client_id || !json.client_secret) {
      throw new CustomerHostError(
        `${new URL(origin).hostname} did not accept the LazyRelay registration (HTTP ${res.status}). Check that it is a Mastodon server and that it allows new apps.`,
      );
    }
    const saved = await saveMastodonApp(origin, this.redirectUri, { clientId: json.client_id, clientSecret: json.client_secret });
    this.customApps.set(origin, saved);
    return saved;
  }

  // The instance says our app no longer exists (an admin revoked it): forget it everywhere.
  private async forgetApp(origin: string): Promise<void> {
    this.customApps.delete(origin);
    try {
      await deleteMastodonApp(origin);
    } catch {
      // The next registration overwrites the row anyway.
    }
  }

  /** `context` is the instance the customer chose, carried through oauth_states.context.
   *  Empty means mastodon.social, exactly as before. */
  async getAuthorizeUrl(state: string, context?: string): Promise<string> {
    const origin = this.originFromContext(context);
    const { clientId } = await this.ensureAppRegistered(origin);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: this.redirectUri,
      scope: SCOPES,
      state,
    });
    return `${origin}/oauth/authorize?${params.toString()}`;
  }

  // Never trusts the stored value blindly: it is normalised again here.
  private originFromContext(context: string | null | undefined): string {
    if (!context) return DEFAULT_INSTANCE;
    const norm = normalizeMastodonInstance(context);
    if (!norm.ok) throw new Error(norm.error);
    return norm.origin;
  }

  async exchangeCode(code: string, _pkceVerifier?: string, context?: string): Promise<OAuthExchangeResult> {
    const origin = this.originFromContext(context);
    if (origin !== DEFAULT_INSTANCE) return this.exchangeCodeCustom(code, origin);

    const { clientId, clientSecret } = await this.ensureAppRegistered(DEFAULT_INSTANCE);

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

  // A customer's own instance. Unlike the default path the account lookup is NOT optional:
  // the account id is "<username>@<host>", which is what keeps two accounts with the same
  // username on different instances apart, so without it nothing can be saved.
  private async exchangeCodeCustom(code: string, origin: string): Promise<OAuthExchangeResult> {
    const host = new URL(origin).hostname;

    // If the instance answers invalid_client the cached app registration was revoked: drop it
    // and register again, once, then retry.
    let token = "";
    for (let attempt = 0; ; attempt++) {
      const { clientId, clientSecret } = await this.ensureAppRegistered(origin);
      const res = await guardedFetch(`${origin}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: this.redirectUri,
          scope: SCOPES,
        }).toString(),
      });
      const json = ((await readJsonCapped(res)) ?? {}) as MastodonTokenResponse;
      if (res.ok && typeof json.access_token === "string" && json.access_token) {
        token = json.access_token;
        break;
      }
      if (json.error === "invalid_client" && attempt === 0) {
        await this.forgetApp(origin);
        continue;
      }
      const reason = typeof json.error === "string" && /^[a-z_]{1,60}$/.test(json.error) ? ` (${json.error})` : "";
      throw new Error(`${host} refused the login${reason}. Try connecting again.`);
    }

    const accountRes = await guardedFetch(`${origin}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const account = ((await readJsonCapped(accountRes)) ?? {}) as MastodonAccount;
    if (!accountRes.ok || typeof account.username !== "string" || !account.username) {
      throw new Error(`${host} accepted the login but did not confirm the account. Try connecting again.`);
    }
    // The username comes from a server the customer chose: it becomes part of the stored account id.
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(account.username)) {
      throw new Error(`${host} returned an account name LazyRelay cannot use. Try a different account.`);
    }

    return {
      accessToken: JSON.stringify({ instance: origin, token }),
      refreshToken: null,
      expiresAt: null,
      platformAccountId: `${account.username}@${host}`,
      // Shown in the accounts list and the confirmation step: the server is part of the name.
      displayName: `${account.username}@${host}`,
    };
  }

  // altText (2026-08-16): Mastodon's media-upload endpoint accepts an
  // optional "description" field for exactly this — the value it returns
  // via the API/renders to users as the image's alt text. Omitted entirely
  // when null, same as not passing it at all — no behavior change for
  // uploads that don't have one.
  private async uploadMedia(c: MastodonCredentials, mediaUrl: string, altText: string | null): Promise<string | null> {
    // Streamed instead of buffered (2026-09-05) -- see streamUpload.ts.
    // redirect: "manual" is applied inside fetchMediaForStreaming (mediaUrl
    // already passed isSafeMediaUrl at write time in routes.ts, but that only
    // checked the URL itself, not wherever it might redirect to -- the
    // default "follow" would happily chase a 3xx into a private/internal
    // address; res.ok is false for any 3xx, so the existing null-return
    // below still closes it). Same fix as webhook.ts's sendVerifiedWebhook.
    //
    // Mastodon's endpoint needs real multipart/form-data, which the
    // standard Blob/FormData APIs can't build without buffering the whole
    // file into a Blob first -- buildStreamingMultipartBody hand-builds the
    // multipart body instead, so the file streams through in chunks the
    // same way the other adapters' raw PUT/POST bodies do.
    const media = await fetchMediaForStreaming(mediaUrl);
    if (!media) return null;

    const parts: Parameters<typeof buildStreamingMultipartBody>[0] = [
      { fieldName: "file", value: { filename: "media", contentType: media.contentType, data: media.body, sizeBytes: media.sizeBytes } },
    ];
    if (altText) parts.push({ fieldName: "description", value: altText });
    const { body, contentType: multipartContentType, contentLength } = buildStreamingMultipartBody(parts);

    // Content-Length set whenever known -- some upload endpoints reject a
    // chunked-transfer body outright (confirmed on Pinterest's S3-style
    // upload, HTTP 411); Mastodon itself accepted chunked fine in testing,
    // but there's no reason not to send a real length whenever it's known.
    const res = await this.send(
      c,
      "/api/v2/media",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.token}`,
          "Content-Type": multipartContentType,
          ...(contentLength != null ? { "Content-Length": String(contentLength) } : {}),
        },
        body,
        duplex: "half",
      } as RequestInitWithDuplex,
      UPLOAD_TIMEOUT_MS,
    );
    if (res.status !== 200 && res.status !== 202) return null;
    const json = await this.readBody<MastodonMedia>(c, res);
    const mediaId = json.id ?? null;
    if (!mediaId) return null;

    if (res.status === 202) {
      const ready = await this.waitForMediaReady(c, mediaId);
      if (!ready) return null;
    }

    return mediaId;
  }

  private async waitForMediaReady(c: MastodonCredentials, mediaId: string): Promise<boolean> {
    const deadline = Date.now() + MEDIA_PROCESSING_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, MEDIA_PROCESSING_POLL_MS));
      const res = await this.send(c, `/api/v1/media/${mediaId}`, {
        headers: { Authorization: `Bearer ${c.token}` },
      });
      if (res.status === 200) return true;
      if (res.status !== 206) return false; // unexpected status -- stop polling, treat as failed
    }
    return false;
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    let c: MastodonCredentials;
    try {
      c = parseMastodonCredentials(request.accessToken);
    } catch (err) {
      return { success: false, platformPostId: null, errorMessage: err instanceof CustomerHostError ? err.message : DAMAGED_MESSAGE };
    }
    // One key per post() call, sent on a customer instance's status creation only. If the answer is lost
    // after the request went out, the key lets the server recognise a repeat of the same request.
    const idempotencyKey = randomUUID();
    try {
      return await this.postWith(c, request, idempotencyKey);
    } catch (err) {
      // Only the customer-host guard's own (safe) errors are turned into a result; anything
      // else propagates exactly as it always did.
      if (err instanceof CustomerHostError) return { success: false, platformPostId: null, errorMessage: err.message };
      throw err;
    }
  }

  private async postWith(c: MastodonCredentials, request: PostRequest, idempotencyKey: string): Promise<PostAttemptResult> {
    let mediaIds: string[] | undefined;
    if (request.mediaUrl) {
      const mediaId = await this.uploadMedia(c, request.mediaUrl, request.mediaAltText ?? null);
      if (!mediaId) {
        return { success: false, platformPostId: null, errorMessage: `Could not upload media from ${request.mediaUrl}` };
      }
      mediaIds = [mediaId];
      // Extra images (multi-image post): uploaded in order, no alt text.
      // Any failed upload aborts before the status is created.
      for (const extraUrl of request.mediaUrls ?? []) {
        const extraId = await this.uploadMedia(c, extraUrl, null);
        if (!extraId) {
          return { success: false, platformPostId: null, errorMessage: `Could not upload media from ${extraUrl}` };
        }
        mediaIds.push(extraId);
      }
    }

    let res: Response;
    try {
      res = await this.postStatusRequest(c, request, mediaIds, idempotencyKey);
    } catch (err) {
      // A timeout or dropped connection after sending: the post may exist. Saying "failed" would
      // let the scheduler retry it into a duplicate.
      if (err instanceof CustomerHostError && err.possiblySent) {
        return {
          success: false,
          platformPostId: null,
          errorMessage: `The result is unconfirmed: the connection to ${new URL(c.origin).hostname} dropped after the post was sent, so it may have been published. Check the account on Mastodon before trying again, so it is not posted twice.`,
        };
      }
      throw err;
    }
    const json = await this.readBody<MastodonStatus>(c, res);

    if (!res.ok || !json.id) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: this.msg(c, json.error, `Mastodon status creation failed (HTTP ${res.status})`),
      };
    }

    return { success: true, platformPostId: json.id, errorMessage: null };
  }

  private postStatusRequest(c: MastodonCredentials, request: PostRequest, mediaIds: string[] | undefined, idempotencyKey: string): Promise<Response> {
    return this.send(c, "/api/v1/statuses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.token}`,
        "Content-Type": "application/json",
        ...(c.isDefault ? {} : { "Idempotency-Key": idempotencyKey }),
      },
      body: JSON.stringify({
        status: request.content,
        visibility: "public",
        ...(mediaIds ? { media_ids: mediaIds } : {}),
      }),
    });
  }

  // Mastodon status creation is synchronous — a 200 from post() means the
  // status already exists. verifyPublished still does a real independent
  // GET rather than trusting post()'s response, per the Proof-of-Publish
  // discipline this whole interface exists for.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    let c: MastodonCredentials;
    try {
      c = parseMastodonCredentials(accessToken);
    } catch (err) {
      return { verifiedLive: false, platformPostUrl: null, errorMessage: err instanceof CustomerHostError ? err.message : DAMAGED_MESSAGE };
    }
    try {
      const res = await this.send(c, `/api/v1/statuses/${platformPostId}`, {
        headers: { Authorization: `Bearer ${c.token}` },
      });
      const json = await this.readBody<MastodonStatus>(c, res);

      if (!res.ok || json.id !== platformPostId) {
        return {
          verifiedLive: false,
          platformPostUrl: null,
          errorMessage: this.msg(c, json.error, `Mastodon status verification failed (HTTP ${res.status})`),
        };
      }

      return {
        verifiedLive: true,
        platformPostUrl: c.isDefault ? (json.url ?? `${c.origin}/web/statuses/${platformPostId}`) : statusLink(c, json.url, platformPostId),
        errorMessage: null,
      };
    } catch (err) {
      if (err instanceof CustomerHostError) return { verifiedLive: false, platformPostUrl: null, errorMessage: err.message };
      throw err;
    }
  }

  // /context's "descendants" are every reply in the thread below this
  // status, not strictly one-level-deep comments — the closest real
  // equivalent Mastodon's API offers to "comments on this post."
  async getComments(platformPostId: string, accessToken: string): Promise<CommentsResult> {
    let c: MastodonCredentials;
    try {
      c = parseMastodonCredentials(accessToken);
    } catch (err) {
      return { comments: [], errorMessage: err instanceof CustomerHostError ? err.message : DAMAGED_MESSAGE };
    }
    try {
      const res = await this.send(c, `/api/v1/statuses/${platformPostId}/context`, {
        headers: { Authorization: `Bearer ${c.token}` },
      });
      const json = c.isDefault
        ? ((await res.json().catch(() => ({}))) as MastodonContext)
        : await this.readBody<MastodonContext>(c, res);
      if (!res.ok) {
        return { comments: [], errorMessage: this.msg(c, json.error, `Could not load replies (HTTP ${res.status})`) };
      }

      const comments = (json.descendants ?? []).flatMap((reply) => {
        if (!reply.id) return [];
        return [
          {
            id: reply.id,
            author: reply.account?.display_name || reply.account?.username || "Unknown",
            text: (reply.content ?? "").replace(/<[^>]+>/g, "").trim(),
            url: c.isDefault ? (reply.url ?? null) : reply.url ? statusLink(c, reply.url, reply.id) : null,
            createdAt: reply.created_at ?? null,
          },
        ];
      });
      return { comments, errorMessage: null };
    } catch (err) {
      if (err instanceof CustomerHostError) return { comments: [], errorMessage: err.message };
      throw err;
    }
  }

  // A reply is just a status with in_reply_to_id set — write:statuses
  // (already granted) covers this, no new scope needed.
  async replyToComment(commentId: string, text: string, accessToken: string): Promise<CommentPostResult> {
    let c: MastodonCredentials;
    try {
      c = parseMastodonCredentials(accessToken);
    } catch (err) {
      return { success: false, errorMessage: err instanceof CustomerHostError ? err.message : DAMAGED_MESSAGE };
    }
    try {
      const res = await this.send(c, "/api/v1/statuses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: text, in_reply_to_id: commentId, visibility: "public" }),
      });
      const json = c.isDefault
        ? ((await res.json().catch(() => ({}))) as MastodonStatus)
        : await this.readBody<MastodonStatus>(c, res);

      if (!res.ok || !json.id) {
        return { success: false, errorMessage: this.msg(c, json.error, `Mastodon reply failed (HTTP ${res.status})`) };
      }

      return { success: true, errorMessage: null, platformReplyId: String(json.id) };
    } catch (err) {
      if (err instanceof CustomerHostError) return { success: false, errorMessage: err.message };
      throw err;
    }
  }

  // Thread chains: a follow-up is a status with in_reply_to_id = the
  // previous status id, same visibility as the main post (public). Returns
  // the new status id for the next reply.
  async postChainReply(input: {
    rootPostId: string;
    parentPostId: string;
    text: string;
    accessToken: string;
    platformAccountId?: string | null;
  }): Promise<{ success: boolean; platformPostId: string | null; errorMessage: string | null }> {
    let c: MastodonCredentials;
    try {
      c = parseMastodonCredentials(input.accessToken);
    } catch (err) {
      return { success: false, platformPostId: null, errorMessage: err instanceof CustomerHostError ? err.message : DAMAGED_MESSAGE };
    }
    try {
      const res = await this.send(c, "/api/v1/statuses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: input.text, in_reply_to_id: input.parentPostId, visibility: "public" }),
      });
      const json = c.isDefault
        ? ((await res.json().catch(() => ({}))) as MastodonStatus)
        : await this.readBody<MastodonStatus>(c, res);
      if (!res.ok || !json.id) {
        return { success: false, platformPostId: null, errorMessage: this.msg(c, json.error, `Mastodon thread reply failed (HTTP ${res.status})`) };
      }
      return { success: true, platformPostId: json.id, errorMessage: null };
    } catch (err) {
      if (err instanceof CustomerHostError) return { success: false, platformPostId: null, errorMessage: err.message };
      throw err;
    }
  }

  // Same endpoint verifyPublished already uses — the status object carries
  // its own engagement counts directly, no separate insights call needed.
  async getPostMetrics(platformPostId: string, accessToken: string): Promise<PostMetrics> {
    const empty = (errorMessage: string): PostMetrics => ({ likes: null, comments: null, shares: null, views: null, errorMessage });
    let c: MastodonCredentials;
    try {
      c = parseMastodonCredentials(accessToken);
    } catch (err) {
      return empty(err instanceof CustomerHostError ? err.message : DAMAGED_MESSAGE);
    }
    try {
      const res = await this.send(c, `/api/v1/statuses/${platformPostId}`, {
        headers: { Authorization: `Bearer ${c.token}` },
      });
      const json = c.isDefault
        ? ((await res.json().catch(() => ({}))) as MastodonStatus)
        : await this.readBody<MastodonStatus>(c, res);
      if (!res.ok || json.id !== platformPostId) {
        return empty(this.msg(c, json.error, `Could not load metrics (HTTP ${res.status})`));
      }
      return {
        likes: json.favourites_count ?? null,
        comments: json.replies_count ?? null,
        shares: json.reblogs_count ?? null,
        views: null, // Mastodon doesn't expose view counts
        errorMessage: null,
      };
    } catch (err) {
      if (err instanceof CustomerHostError) return empty(err.message);
      throw err;
    }
  }

  // Audience growth (2026-08-17) — same endpoint already used for the
  // connect-time display-name lookup above, needs no additional scope
  // beyond the read:accounts already granted.
  async getFollowerCount(accessToken: string): Promise<number | null> {
    let c: MastodonCredentials;
    try {
      c = parseMastodonCredentials(accessToken);
    } catch {
      console.error("[mastodon] getFollowerCount failed: saved connection is damaged");
      return null;
    }
    try {
      const res = await this.send(c, "/api/v1/accounts/verify_credentials", {
        headers: { Authorization: `Bearer ${c.token}` },
      });
      if (!res.ok) {
        if (c.isDefault) {
          const body = await res.text().catch(() => "");
          console.error(`[mastodon] getFollowerCount failed: HTTP ${res.status} ${body.slice(0, 500)}`);
        } else {
          await res.body?.cancel().catch(() => undefined);
          console.error(`[mastodon] getFollowerCount failed: host=${new URL(c.origin).hostname} HTTP ${res.status}`);
        }
        return null;
      }
      const json = c.isDefault
        ? ((await res.json().catch(() => ({}))) as MastodonAccount)
        : await this.readBody<MastodonAccount>(c, res);
      return json.followers_count ?? null;
    } catch (err) {
      if (err instanceof CustomerHostError) {
        console.error(`[mastodon] getFollowerCount failed: host=${new URL(c.origin).hostname} ${err.message}`);
        return null;
      }
      throw err;
    }
  }
}
