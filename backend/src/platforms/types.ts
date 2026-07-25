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

export interface OAuthExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null; // ISO timestamp, null if the platform doesn't expire tokens
  platformAccountId: string;
  displayName: string | null;
}

export interface PlatformAdapter {
  readonly platform: "meta" | "tiktok" | "pinterest" | "youtube" | "mastodon" | "bluesky" | "telegram" | "linkedin" | "threads";

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
   *  callers must not log or persist the raw result anywhere else. */
  exchangeCode(code: string): Promise<OAuthExchangeResult>;

  post(request: PostRequest): Promise<PostAttemptResult>;
  verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult>;
}
