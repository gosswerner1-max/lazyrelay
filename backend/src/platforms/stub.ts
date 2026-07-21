import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
} from "./types.js";

// Placeholder adapter — lets the scheduling engine AND the connect flow be
// built and tested end to end before real Meta/TikTok/Pinterest credentials
// exist (Phase 0, blocked on developer app registration + dev mode). Swap
// this for the real Meta adapter once that's in place; the scheduler and
// HTTP routes shouldn't need to change, since they only depend on
// PlatformAdapter.
export class StubAdapter implements PlatformAdapter {
  readonly platform: "meta" = "meta";

  getAuthorizeUrl(state: string): string {
    return `https://stub.invalid/oauth/authorize?state=${encodeURIComponent(state)}`;
  }

  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    console.log(`[stub] would exchange code "${code}" for a real token`);
    return {
      accessToken: `stub_access_token_${Date.now()}`,
      refreshToken: `stub_refresh_token_${Date.now()}`,
      expiresAt: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString(),
      platformAccountId: `stub_page_${Date.now()}`,
      displayName: "Stub Test Page",
    };
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    console.log(`[stub] would post to ${request.socialAccountId}: "${request.content}"`);
    return {
      success: true,
      platformPostId: `stub_${Date.now()}`,
      errorMessage: null,
    };
  }

  async verifyPublished(platformPostId: string): Promise<VerifyResult> {
    console.log(`[stub] would verify ${platformPostId} is actually live`);
    return {
      verifiedLive: true,
      platformPostUrl: `https://stub.invalid/${platformPostId}`,
      errorMessage: null,
    };
  }
}
