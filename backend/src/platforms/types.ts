// Every platform integration (Meta first, per the resolved build priority,
// then TikTok/Pinterest) implements this interface. Keeping posting and
// verification as separate methods matters: a successful post() call is
// NOT proof the content is actually live — that's what verifyPublished()
// is for, and it's the whole Proof-of-Publish differentiator, so it must
// never be treated as optional or folded into post() as an afterthought.

export interface PostRequest {
  socialAccountId: string;
  content: string;
  mediaUrl: string | null;
  // Only consumed by adapters that need a still image alongside video media
  // (currently Pinterest video Pins, which require cover_image_url) — every
  // other adapter simply ignores it.
  coverImageUrl: string | null;
  // Only consumed by Pinterest — lets a customer pick which of their boards
  // a Pin goes to. Optional/null means "use the adapter's own fallback"
  // (currently whichever board the account's boards list returns first, or
  // an auto-created default) — every existing caller (test scripts, older
  // scheduled_posts rows) that doesn't set this keeps working unchanged.
  boardId?: string | null;
  accessToken: string;
}

export interface PostAttemptResult {
  success: boolean;
  platformPostId: string | null;
  errorMessage: string | null;
}

export interface VerifyResult {
  verifiedLive: boolean;
  platformPostUrl: string | null;
  errorMessage: string | null;
}

export interface CommentItem {
  id: string;
  author: string;
  text: string;
  url: string | null;
  createdAt: string | null;
}

export interface CommentsResult {
  comments: CommentItem[];
  errorMessage: string | null;
}

export interface PostMetrics {
  likes: number | null;
  comments: number | null;
  shares: number | null;
  views: number | null;
  errorMessage: string | null;
}

export interface OAuthExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null; // ISO timestamp, null if the platform doesn't expire tokens
  platformAccountId: string;
  displayName: string | null;
}

export interface PlatformAdapter {
  readonly platform: "meta" | "tiktok" | "pinterest" | "youtube" | "mastodon" | "bluesky" | "telegram" | "linkedin" | "threads" | "facebook" | "instagram" | "discord" | "tumblr" | "x" | "snapchat";

  /** The URL to send a user to in order to start connecting an account.
   *  `state` must be echoed back on the callback and checked — it's what
   *  ties a callback to the specific LazyRelay account that started the
   *  flow, so one user can't accidentally (or maliciously) connect a
   *  platform account to someone else's LazyRelay account. Async because
   *  some platforms (Mastodon's per-instance app registration, Bluesky's
   *  PAR round-trip) need a real network call before a URL exists — unlike
   *  Meta/TikTok/Pinterest/YouTube, which can build one synchronously. */
  getAuthorizeUrl(state: string): Promise<string>;

  /** Exchanges the OAuth callback code for real tokens + the platform's
   *  own account id/display name. This is the one place a plaintext token
   *  is ever held in memory before being handed to Vault for encryption —
   *  callers must not log or persist the raw result anywhere else.
   *  `pkceVerifier` is optional and only used by platforms whose OAuth flow
   *  is PKCE-only (X) — connect.ts reads it back from the oauth_states row
   *  before deleting it and passes it through; every other adapter simply
   *  doesn't declare the parameter. */
  exchangeCode(code: string, pkceVerifier?: string): Promise<OAuthExchangeResult>;

  post(request: PostRequest): Promise<PostAttemptResult>;
  verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult>;

  /** Optional — "social listening" in the only honest sense this codebase
   *  can currently deliver: reading comments/replies on a post LazyRelay
   *  itself published, using the access token already on file. NOT
   *  keyword/brand-mention search across public content platform-wide —
   *  that needs each platform's search API, most of which are separately
   *  gated/paid and out of scope for this pass. Only implemented for
   *  platforms whose comment-read endpoint needs no scope beyond what's
   *  already requested (Mastodon, Bluesky, YouTube) — every other adapter
   *  simply doesn't declare this method, and callers must treat its
   *  absence as "not supported," never silently empty. */
  getComments?(platformPostId: string, accessToken: string): Promise<CommentsResult>;

  /** Optional — real engagement metrics (likes/comments/shares/views) for a
   *  post LazyRelay itself published, using the access token already on
   *  file. Only implemented for platforms whose metrics-read endpoint needs
   *  no scope beyond what's already requested (Facebook, Instagram,
   *  Mastodon, Bluesky, X, YouTube — see reference-infra-quick-facts.md for
   *  the scope audit). Every other adapter simply doesn't declare this
   *  method; callers (the metrics poller) must treat its absence as "not
   *  supported," never silently skip and pretend it was polled. Fields the
   *  platform doesn't expose stay `null`, not `0` — a real zero and "we
   *  don't know" must never be conflated. */
  getPostMetrics?(platformPostId: string, accessToken: string): Promise<PostMetrics>;

  /** Optional — real board/list selection for platforms whose post()
   *  requires picking a destination container the customer can actually
   *  choose (currently only Pinterest, via PostRequest.boardId). Every
   *  other adapter simply doesn't declare this method; callers must treat
   *  its absence as "this platform has nothing to pick," not an error. */
  listBoards?(accessToken: string): Promise<{ id: string; name: string }[]>;

  /** Optional — exchanges a stored refresh token for a fresh access token.
   *  Only declared by adapters whose access tokens actually expire and
   *  support a refresh grant (TikTok confirmed as a real, live gap — access
   *  token dead within ~24h, refresh token captured at connect time but
   *  never used anywhere). Callers must treat its absence as "this
   *  platform's tokens don't expire / can't be refreshed this way," not an
   *  error — e.g. Meta/Pinterest/Mastodon/Bluesky/Telegram tokens are
   *  long-lived or don't use this grant shape. */
  refresh?(refreshToken: string): Promise<OAuthExchangeResult>;
}
