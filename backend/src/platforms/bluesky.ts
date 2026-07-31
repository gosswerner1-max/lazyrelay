import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
  CommentsResult,
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

interface BlueskyGetPostThreadResponse {
  thread?: { replies?: BlueskyPostThreadReply[] };
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
      // Access JWTs are short-lived (real AT Protocol behavior, not
      // configurable here) but PostRequest/verifyPublished have no
      // refresh-on-demand path today, matching every other adapter's
      // current scope — a real limitation, not an oversight.
      expiresAt: null,
      platformAccountId: json.did,
      displayName,
    };
  }

  private async uploadBlob(mediaUrl: string, accessToken: string): Promise<BlueskyBlobRef | null> {
    const mediaRes = await fetch(mediaUrl);
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
        images: [{ alt: "", image: blob }],
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
}
