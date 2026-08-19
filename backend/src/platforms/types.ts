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
  // Only consumed by Pinterest -- the Pin's own "Destination Link" (where a
  // click on the Pin takes someone), distinct from mediaUrl (the image/video
  // itself). Found missing entirely in a 2026-08-19 security review: Pin
  // creation never sent Pinterest's `link` field at all, so every Pin's
  // destination link was silently blank. Every other adapter ignores it,
  // same accepted-but-unused pattern as boardId/coverImageUrl.
  destinationLink?: string | null;
  // Accessibility description of the attached media (2026-08-16). Only
  // consumed by adapters whose platform API supports it on media upload —
  // currently Mastodon. Every other adapter simply ignores it, same
  // accepted-but-unused pattern as coverImageUrl/boardId above.
  mediaAltText?: string | null;
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

export interface CommentPostResult {
  success: boolean;
  errorMessage: string | null;
}

export interface DMConversation {
  id: string;
  participantId: string;
  participantName: string;
  snippet: string | null;
  updatedAt: string | null;
}

export interface DMConversationsResult {
  conversations: DMConversation[];
  errorMessage: string | null;
}

export interface DMMessage {
  id: string;
  // Raw sender identity, not a pre-computed "isOwn" boolean — the caller
  // (the /dms route) compares fromId against the connected account's own
  // platform_account_id, since that's the one place that actually knows
  // which account is "us" for a given conversation.
  fromId: string;
  fromName: string;
  text: string;
  createdAt: string | null;
}

export interface DMMessagesResult {
  messages: DMMessage[];
  errorMessage: string | null;
}

export interface SendDMResult {
  success: boolean;
  errorMessage: string | null;
}

export interface OAuthExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null; // ISO timestamp, null if the platform doesn't expire tokens
  platformAccountId: string;
  displayName: string | null;
}

export interface ConnectOption {
  id: string;
  name: string;
}

export interface PendingConnectSelection {
  // Long-lived platform user token, held server-side only (vault-encrypted
  // by the caller, same as every other token this codebase stores) until
  // the customer picks one — never sent to the frontend.
  userToken: string;
  options: ConnectOption[];
}

export interface PlatformAdapter {
  readonly platform: "meta" | "tiktok" | "pinterest" | "youtube" | "mastodon" | "bluesky" | "telegram" | "linkedin" | "threads" | "facebook" | "instagram" | "discord" | "tumblr" | "x" | "snapchat" | "google-business";

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

  /** Optional — posts a follow-up comment on a post LazyRelay itself just
   *  published (the common "hide hashtags in the first comment" pattern).
   *  Only called after verifyPublished() has already confirmed the parent
   *  post is live — a comment failure must never fail or retry the parent
   *  post. Only implemented for platforms this is validated for (Facebook,
   *  Instagram — see project-competitor-feature-audit-2026-08-07.md for the
   *  v1 scope decision). Every other adapter simply doesn't declare this
   *  method; callers must treat its absence as "not supported," not an
   *  error. */
  postComment?(platformPostId: string, text: string, accessToken: string): Promise<CommentPostResult>;

  /** Optional — replies to an EXISTING comment (from the CommentItem.id
   *  returned by getComments), as opposed to postComment's "new top-level
   *  comment on our own post." Only implemented for platforms where this is
   *  unblocked with an already-requested scope (Facebook, Instagram,
   *  Mastodon, Bluesky) — YouTube needs a new sensitive scope
   *  (youtube.force-ssl) that would likely extend its already-pending
   *  Google app-verification review, so it's deliberately out of this pass.
   *  Every other adapter simply doesn't declare this method; callers must
   *  treat its absence as "not supported," not an error. */
  replyToComment?(commentId: string, text: string, accessToken: string): Promise<CommentPostResult>;

  /** Optional — DM inbox, priority (4) from the 2026-08-07 competitor
   *  audit. Only Facebook and Instagram declare these — both needed a new
   *  permission (pages_messaging / instagram_manage_messages) added to the
   *  Meta app on 2026-08-07 specifically for this. Every other adapter
   *  simply doesn't declare these methods; callers must treat their
   *  absence as "no DM support," never an error. */
  getConversations?(accessToken: string): Promise<DMConversationsResult>;
  getDirectMessages?(conversationId: string, accessToken: string): Promise<DMMessagesResult>;

  /** Sending is genuinely gated by each platform's own customer-service
   *  messaging window (Meta: 24 hours since the customer's last message,
   *  outside a small set of pre-approved tags this codebase doesn't
   *  implement) — a send outside that window fails with a real API error
   *  from the platform, surfaced honestly via errorMessage rather than
   *  silently retried or hidden. */
  sendDirectMessage?(recipientId: string, text: string, accessToken: string): Promise<SendDMResult>;

  /** Optional — DM automation, priority (5). Deliberately NOT the same as
   *  sendDirectMessage: Meta's regular messaging window only opens once a
   *  customer has messaged the Page/account directly, but Meta built a
   *  separate, sanctioned mechanism — a "private reply" to a comment —
   *  specifically so a business can DM someone who merely commented,
   *  without that restriction. Using sendDirectMessage for this would
   *  fail outside the 24h window; this is the actually-correct call. */
  sendPrivateReply?(commentId: string, text: string, accessToken: string): Promise<SendDMResult>;

  /** Optional — for platforms where a single OAuth login can map to several
   *  destinations (a Facebook user can manage multiple Pages; Instagram
   *  posting goes through whichever Page has a Business Account linked).
   *  When declared, connect.ts calls this INSTEAD of exchangeCode. Exactly
   *  one real option finalizes immediately, same UX as a plain exchangeCode
   *  connect — more than one pauses the flow so the customer picks, rather
   *  than silently connecting whichever the platform API happens to list
   *  first. Every other adapter simply doesn't declare this, and connect.ts
   *  falls back to exchangeCode as before. */
  listConnectOptions?(code: string, pkceVerifier?: string): Promise<PendingConnectSelection>;

  /** Required alongside listConnectOptions — finishes the connection once
   *  the customer has picked one of the options it returned. */
  finalizeConnectOption?(userToken: string, selectedId: string): Promise<OAuthExchangeResult>;

  /** Optional — the audience-growth half of "advanced analytics" (2026-08-17,
   *  see project-lazyrelay-vs-socialbee-feature-roadmap-2026-08-16). Only
   *  declared by adapters that can read a follower/subscriber count with a
   *  scope LazyRelay already has approved — Mastodon, Bluesky, YouTube.
   *  Deliberately NOT built for Facebook/Instagram (real follower insights
   *  need read_insights, a permission outside the set currently under Meta
   *  review — must not touch that app while its review is open) or
   *  TikTok/Pinterest (their audience-insight endpoints need elevated scopes
   *  LazyRelay doesn't have). Every other adapter simply doesn't declare
   *  this; callers (the audience snapshot poller) must treat its absence as
   *  "not supported," never silently skip and pretend it was polled. */
  getFollowerCount?(accessToken: string): Promise<number | null>;
}
