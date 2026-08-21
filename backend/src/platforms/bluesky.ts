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

// Real, confirmed platform gotcha: AT Protocol's real OAuth (PAR + DPoP +
// self-hosted client-metadata document) issues DPoP-bound sessions that
// can't be used as a plain reusable Bearer token from a separate request —
// they require restoring a live session object through the OAuth SDK's own
// store every time. That doesn't fit LazyRelay's token model (Vault stores
// one opaque bearer string per connected account, reused as-is by post()/
// verifyPublished() later). App passwords, by contrast, produce a normal
// accessJwt/refreshJwt pair via a single POST — a real, still-supported,
// still-working auth method that fits this adapter's existing shape
// cleanly, even though Bluesky's own docs nudge new integrations toward
// full OAuth. Deliberate choice, not an oversight — see
// project-platform-app-registration memory for the tradeoff discussion.
const DEFAULT_PDS = "https://bsky.social";
const CREATE_SESSION_URL = `${DEFAULT_PDS}/xrpc/com.atproto.server.createSession`;
const REFRESH_SESSION_URL = `${DEFAULT_PDS}/xrpc/com.atproto.server.refreshSession`;
const CREATE_RECORD_URL = `${DEFAULT_PDS}/xrpc/com.atproto.repo.createRecord`;
const GET_RECORD_URL = `${DEFAULT_PDS}/xrpc/com.atproto.repo.getRecord`;
const UPLOAD_BLOB_URL = `${DEFAULT_PDS}/xrpc/com.atproto.repo.uploadBlob`;
const GET_PROFILE_URL = "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile";
const GET_POST_THREAD_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread";

const POST_COLLECTION = "app.bsky.feed.post";

interface BlueskySession {
  accessJwt?: string;
  refreshJwt?: string;
  handle?: string;
  did?: string;
  error?: string;
  message?: string;
}

interface BlueskyProfile {
  displayName?: string;
  handle?: string;
  followersCount?: number;
}

interface BlueskyBlobRef {
  $type: string;
  ref: { $link: string };
  mimeType: string;
  size: number;
}

interface BlueskyUploadBlobResponse {
  blob?: BlueskyBlobRef;
  error?: string;
  message?: string;
}

interface BlueskyCreateRecordResponse {
  uri?: string;
  cid?: string;
  error?: string;
  message?: string;
}

interface BlueskyGetRecordResponse {
  uri?: string;
  error?: string;
  message?: string;
}

interface BlueskyPostThreadReply {
  post?: {
    uri?: string;
    record?: { text?: string; createdAt?: string };
    author?: { displayName?: string; handle?: string };
  };
}

interface BlueskyThreadPost {
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
}

interface BlueskyGetPostThreadResponse {
  thread?: { post?: BlueskyThreadPost; replies?: BlueskyPostThreadReply[] };
  error?: string;
  message?: string;
}

// Separate, minimal shape for reply resolution — only the uri/cid refs a
// reply record needs, walked up via the recursive `parent` chain
// getPostThread's parentHeight param returns.
interface BlueskyThreadRef {
  uri?: string;
  cid?: string;
}

interface BlueskyThreadViewNode {
  post?: BlueskyThreadRef;
  parent?: BlueskyThreadViewNode;
}

interface BlueskyReplyThreadResponse {
  thread?: BlueskyThreadViewNode;
  error?: string;
  message?: string;
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v|webm)(\?.*)?$/i.test(url);
}

// A post's "at://did/.../{rkey}" uri's final path segment is the rkey used
// both for the public bsky.app URL and for getRecord lookups.
function rkeyFromAtUri(uri: string): string {
  return uri.split("/").pop() ?? uri;
}

export class BlueskyAdapter implements PlatformAdapter {
  readonly platform: "bluesky" = "bluesky";

  // No external OAuth provider to redirect to for the app-password flow —
  // this points at LazyRelay's own connect page instead, which is expected
  // to collect a handle + app password and resubmit them as the "code"
  // (JSON-encoded) to the existing generic /social-accounts/callback
  // route. Real, working backend plumbing; the frontend connect-form page
  // itself is NOT built as part of this adapter — flagged as a real
  // pending gap, not silently assumed done.
  constructor(private readonly connectPageUrl: string) {}

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({ state });
    return `${this.connectPageUrl}?${params.toString()}`;
  }

  // `code` here is a JSON string `{"identifier":"...","password":"..."}` —
  // see the class-level comment for why there's no real OAuth code to
  // exchange for this platform.
  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    let identifier: string;
    let password: string;
    try {
      const parsed = JSON.parse(code) as { identifier?: string; password?: string };
      if (!parsed.identifier || !parsed.password) throw new Error("missing fields");
      identifier = parsed.identifier;
      password = parsed.password;
    } catch {
      throw new Error("Bluesky connect requires a handle and app password");
    }

    const res = await fetch(CREATE_SESSION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    });
    const json = (await res.json()) as BlueskySession;

    if (!res.ok || !json.accessJwt || !json.did) {
      throw new Error(json.message ?? json.error ?? "Bluesky sign-in failed");
    }

    // Best-effort display-name lookup — a failure here shouldn't block the
    // connect flow (mirrors every other adapter's non-fatal display-name
    // lookup).
    let displayName: string | null = json.handle ?? null;
    try {
      const profileRes = await fetch(`${GET_PROFILE_URL}?actor=${encodeURIComponent(json.did)}`);
      const profileJson = (await profileRes.json()) as BlueskyProfile;
      if (profileJson.displayName) displayName = profileJson.displayName;
    } catch {
      // Non-fatal — see comment above.
    }

    return {
      accessToken: json.accessJwt,
      refreshToken: json.refreshJwt ?? null,
      // Access JWTs are short-lived (real AT Protocol behavior) — confirmed
      // live 2026-08-17: a freshly-connected token failed with "Token has
      // expired" on its very next scheduled post. Conservative 90-minute
      // estimate (bsky.social doesn't publish an exact TTL) so
      // getAccessToken()'s proactive refresh in scheduler.ts fires well
      // before the real expiry rather than relying on this ever being null.
      expiresAt: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
      platformAccountId: json.did,
      displayName,
    };
  }

  // Confirmed live 2026-08-17 as a real, reproducible gap (not theoretical):
  // access JWTs expire and every post after that fails until reconnected,
  // since refreshJwt was captured at connect time but never used anywhere.
  // com.atproto.server.refreshSession takes the refresh token itself as the
  // Bearer credential, not in the body — the one real deviation from every
  // other adapter's refresh() shape here.
  async refresh(refreshToken: string): Promise<OAuthExchangeResult> {
    const res = await fetch(REFRESH_SESSION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${refreshToken}` },
    });
    const json = (await res.json()) as BlueskySession;
    if (!res.ok || !json.accessJwt) {
      throw new Error(json.message ?? json.error ?? "Bluesky session refresh failed");
    }
    return {
      accessToken: json.accessJwt,
      refreshToken: json.refreshJwt ?? refreshToken,
      expiresAt: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
      platformAccountId: "",
      displayName: "",
    };
  }

  private async uploadBlob(mediaUrl: string, accessToken: string): Promise<BlueskyBlobRef | null> {
    // redirect: "manual" — see mastodon.ts's uploadMedia for the full
    // rationale (closes the adapter-side redirect-following SSRF gap;
    // res.ok is false for any 3xx here, so the existing failure path below
    // already handles it).
    const mediaRes = await fetch(mediaUrl, { redirect: "manual" });
    if (!mediaRes.ok || !mediaRes.body) return null;
    const buffer = Buffer.from(await mediaRes.arrayBuffer());
    const contentType = mediaRes.headers.get("content-type") ?? "application/octet-stream";

    const res = await fetch(UPLOAD_BLOB_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": contentType,
      },
      body: buffer,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as BlueskyUploadBlobResponse;
    return json.blob ?? null;
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    if (request.mediaUrl && isVideoUrl(request.mediaUrl)) {
      // Video embeds need app.bsky.embed.video plus a separate processing/
      // status-poll step this adapter doesn't implement yet — an honest
      // failure rather than a broken video-post attempt, same shape as
      // Pinterest's video-Pin gap.
      return {
        success: false,
        platformPostId: null,
        errorMessage: "Bluesky video posts are not yet supported by this adapter",
      };
    }

    let embed: unknown;
    if (request.mediaUrl) {
      const blob = await this.uploadBlob(request.mediaUrl, request.accessToken);
      if (!blob) {
        return { success: false, platformPostId: null, errorMessage: `Could not upload media from ${request.mediaUrl}` };
      }
      embed = {
        $type: "app.bsky.embed.images",
        // Was hardcoded to "" (found in a 2026-08-19 security review) —
        // PostRequest.mediaAltText already existed and worked for Mastodon,
        // but this adapter never read it, so a customer's alt text silently
        // never reached Bluesky with no error telling them it didn't work.
        images: [{ alt: request.mediaAltText ?? "", image: blob }],
      };
    }

    // repo must be a did/handle — the access token's owner is looked up
    // once here rather than threading platformAccountId through
    // PostRequest, matching how every other adapter derives what it needs
    // from the access token alone.
    const sessionRes = await fetch(
      `${DEFAULT_PDS}/xrpc/com.atproto.server.getSession`,
      { headers: { Authorization: `Bearer ${request.accessToken}` } },
    );
    const sessionJson = (await sessionRes.json()) as { did?: string; message?: string };
    if (!sessionRes.ok || !sessionJson.did) {
      return { success: false, platformPostId: null, errorMessage: sessionJson.message ?? "Bluesky session lookup failed" };
    }

    const res = await fetch(CREATE_RECORD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repo: sessionJson.did,
        collection: POST_COLLECTION,
        record: {
          $type: POST_COLLECTION,
          text: request.content,
          createdAt: new Date().toISOString(),
          langs: ["en"],
          ...(embed ? { embed } : {}),
        },
      }),
    });
    const json = (await res.json()) as BlueskyCreateRecordResponse;

    if (!res.ok || !json.uri) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: json.message ?? json.error ?? `Bluesky post creation failed (HTTP ${res.status})`,
      };
    }

    // platformPostId stores the full at:// uri (repo + collection + rkey)
    // — verifyPublished needs all three, not just the rkey.
    return { success: true, platformPostId: json.uri, errorMessage: null };
  }

  // com.atproto.repo.createRecord succeeding means the record is durably
  // written to the user's repo, but that's not the same as it being
  // publicly indexed/visible — verifyPublished still does a real
  // independent GET rather than trusting post()'s response, per the
  // Proof-of-Publish discipline this whole interface exists for.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const atUri = platformPostId; // "at://{did}/app.bsky.feed.post/{rkey}"
    const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(atUri);
    if (!match) {
      return { verifiedLive: false, platformPostUrl: null, errorMessage: `Not a valid Bluesky post uri: ${atUri}` };
    }
    const [, did, collection, rkey] = match;

    const res = await fetch(
      `${GET_RECORD_URL}?repo=${encodeURIComponent(did)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const json = (await res.json()) as BlueskyGetRecordResponse;

    if (!res.ok || json.uri !== atUri) {
      return {
        verifiedLive: false,
        platformPostUrl: null,
        errorMessage: json.message ?? json.error ?? `Bluesky post verification failed (HTTP ${res.status})`,
      };
    }

    return {
      verifiedLive: true,
      platformPostUrl: `https://bsky.app/profile/${did}/post/${rkey}`,
      errorMessage: null,
    };
  }

  // Public, unauthenticated read — Bluesky's own thread endpoint doesn't
  // need the connected account's token for a public post, but this still
  // only surfaces top-level replies (thread.replies), not the full
  // recursive tree.
  async getComments(platformPostId: string): Promise<CommentsResult> {
    const atUri = platformPostId;
    const url = `${GET_POST_THREAD_URL}?uri=${encodeURIComponent(atUri)}&depth=1`;
    const res = await fetch(url);
    const json = (await res.json().catch(() => ({}))) as BlueskyGetPostThreadResponse;
    if (!res.ok) {
      return { comments: [], errorMessage: json.message ?? json.error ?? `Could not load replies (HTTP ${res.status})` };
    }

    const comments = (json.thread?.replies ?? []).flatMap((reply) => {
      const post = reply.post;
      if (!post?.uri) return [];
      const match = /^at:\/\/([^/]+)\/[^/]+\/([^/]+)$/.exec(post.uri);
      return [
        {
          id: post.uri,
          author: post.author?.displayName || post.author?.handle || "Unknown",
          text: post.record?.text ?? "",
          url: match ? `https://bsky.app/profile/${match[1]}/post/${match[2]}` : null,
          createdAt: post.record?.createdAt ?? null,
        },
      ];
    });
    return { comments, errorMessage: null };
  }

  // Bluesky replies need BOTH a root ref and a parent ref (each {uri, cid})
  // — unlike Facebook/Instagram's flat "/{id}/comments", the AT Protocol
  // record itself encodes the whole reply chain. commentId only carries a
  // uri (from getComments' CommentItem.id), so cid is resolved here via
  // getPostThread's parentHeight, walking the parent chain up to the root
  // rather than assuming a fixed depth — correct even if Bluesky's app
  // ever surfaces nested (not just one-level) comment threads later.
  async replyToComment(commentId: string, text: string, accessToken: string): Promise<CommentPostResult> {
    const threadUrl = `${GET_POST_THREAD_URL}?uri=${encodeURIComponent(commentId)}&depth=0&parentHeight=10`;
    const threadRes = await fetch(threadUrl);
    const threadJson = (await threadRes.json().catch(() => ({}))) as BlueskyReplyThreadResponse;
    const commentRef = threadJson.thread?.post;
    if (!threadRes.ok || !commentRef?.uri || !commentRef?.cid) {
      return {
        success: false,
        errorMessage: threadJson.message ?? threadJson.error ?? "Could not resolve the comment being replied to",
      };
    }

    let rootRef = commentRef;
    let ancestor = threadJson.thread?.parent;
    while (ancestor?.post?.uri && ancestor.post.cid) {
      rootRef = ancestor.post;
      ancestor = ancestor.parent;
    }

    const sessionRes = await fetch(`${DEFAULT_PDS}/xrpc/com.atproto.server.getSession`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const sessionJson = (await sessionRes.json()) as { did?: string; message?: string };
    if (!sessionRes.ok || !sessionJson.did) {
      return { success: false, errorMessage: sessionJson.message ?? "Bluesky session lookup failed" };
    }

    const res = await fetch(CREATE_RECORD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repo: sessionJson.did,
        collection: POST_COLLECTION,
        record: {
          $type: POST_COLLECTION,
          text,
          createdAt: new Date().toISOString(),
          langs: ["en"],
          reply: {
            root: { uri: rootRef.uri, cid: rootRef.cid },
            parent: { uri: commentRef.uri, cid: commentRef.cid },
          },
        },
      }),
    });
    const json = (await res.json()) as BlueskyCreateRecordResponse;
    if (!res.ok || !json.uri) {
      return { success: false, errorMessage: json.message ?? json.error ?? `Bluesky reply failed (HTTP ${res.status})` };
    }

    return { success: true, errorMessage: null };
  }

  // Same getPostThread endpoint as getComments — the root post's own
  // counts ride along in the same response, public/no accessToken needed.
  async getPostMetrics(platformPostId: string): Promise<PostMetrics> {
    const atUri = platformPostId;
    const url = `${GET_POST_THREAD_URL}?uri=${encodeURIComponent(atUri)}&depth=0`;
    const res = await fetch(url);
    const json = (await res.json().catch(() => ({}))) as BlueskyGetPostThreadResponse;
    if (!res.ok) {
      return {
        likes: null,
        comments: null,
        shares: null,
        views: null,
        errorMessage: json.message ?? json.error ?? `Could not load metrics (HTTP ${res.status})`,
      };
    }
    return {
      likes: json.thread?.post?.likeCount ?? null,
      comments: json.thread?.post?.replyCount ?? null,
      shares: json.thread?.post?.repostCount ?? null,
      views: null, // Bluesky doesn't expose view counts on a post
      errorMessage: null,
    };
  }

  // Audience growth (2026-08-17) — same getSession-then-getProfile lookup
  // post() already does to resolve the token's own did, needs no scope
  // beyond what app-password sign-in already grants.
  async getFollowerCount(accessToken: string): Promise<number | null> {
    const sessionRes = await fetch(`${DEFAULT_PDS}/xrpc/com.atproto.server.getSession`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const sessionJson = (await sessionRes.json().catch(() => ({}))) as { did?: string };
    if (!sessionRes.ok || !sessionJson.did) {
      console.error(`[bluesky] getFollowerCount failed at getSession: HTTP ${sessionRes.status} ${JSON.stringify(sessionJson).slice(0, 500)}`);
      return null;
    }

    const profileRes = await fetch(`${GET_PROFILE_URL}?actor=${encodeURIComponent(sessionJson.did)}`);
    if (!profileRes.ok) {
      const body = await profileRes.text().catch(() => "");
      console.error(`[bluesky] getFollowerCount failed at getProfile: HTTP ${profileRes.status} ${body.slice(0, 500)}`);
      return null;
    }
    const profileJson = (await profileRes.json().catch(() => ({}))) as BlueskyProfile;
    return profileJson.followersCount ?? null;
  }
}
