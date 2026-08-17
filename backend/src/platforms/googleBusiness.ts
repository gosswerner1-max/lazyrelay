import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
  PendingConnectSelection,
  ConnectOption,
} from "./types.js";
import { supabase } from "../supabase.js";

// Built 2026-08-17, code-complete but UNTESTED against a real API response —
// unlike every other adapter in this codebase. Google Business Profile APIs
// are fully gated: the API isn't even visible in the Cloud Console until
// Google approves a separate access-request form (confirmed live against
// developers.google.com/my-business/content/basic-setup 2026-08-17), a
// stricter gate than a standard OAuth-scope verification review. Nothing
// here can be exercised for real until that access request is approved.
// Re-verify every endpoint shape below against the real API the first time
// this can actually be tested, rather than trusting this summary.
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ACCOUNTS_URL = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
const LOCATIONS_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";
// Local Posts have no v1 equivalent yet — still the legacy v4 "My Business
// API" surface, confirmed live against Google's own reference docs.
const LOCAL_POSTS_BASE = "https://mybusiness.googleapis.com/v4";

const SCOPES = "https://www.googleapis.com/auth/business.manage";

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GoogleBusinessAccount {
  name?: string; // "accounts/{accountId}"
  accountName?: string;
}

interface GoogleBusinessLocation {
  name?: string; // "locations/{locationId}"
  title?: string;
}

interface LocalPost {
  name?: string; // "accounts/{a}/locations/{l}/localPosts/{p}"
  searchUrl?: string;
  state?: string;
}

interface GoogleErrorBody {
  error?: { message?: string };
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v)(\?.*)?$/i.test(url);
}

export class GoogleBusinessAdapter implements PlatformAdapter {
  readonly platform: "google-business" = "google-business";

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
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  private async exchangeTokens(code: string): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: string | null }> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: this.redirectUri,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await res.json()) as GoogleTokenResponse;
    if (!res.ok || !json.access_token) {
      throw new Error(json.error_description ?? json.error ?? "Google token exchange failed");
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
    };
  }

  // Required alongside listConnectOptions -- connect.ts prefers the picker
  // when both exist, but this stays a real, working fallback (auto-picks
  // the first location), same pattern as FacebookAdapter's exchangeCode.
  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    const selection = await this.listConnectOptions(code);
    const [first] = selection.options;
    if (!first) {
      throw new Error("No Google Business Profile location found on this account");
    }
    return this.finalizeConnectOption(selection.userToken, first.id);
  }

  // A Business Profile login can manage several locations (multiple
  // storefronts under one account) — same "customer must pick" shape as
  // Facebook's Page picker, reusing the same listConnectOptions/
  // finalizeConnectOption mechanism. Deliberately scoped to the FIRST
  // account only (most solo-business customers have exactly one) rather
  // than also picking across multiple accounts — a real, documented
  // limitation, same pattern as this codebase's other adapters' honest
  // stopgaps (TikTok's SELF_ONLY, Mastodon's single-instance hardcode).
  async listConnectOptions(code: string): Promise<PendingConnectSelection> {
    const tokens = await this.exchangeTokens(code);

    const accountsRes = await fetch(ACCOUNTS_URL, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const accountsJson = (await accountsRes.json().catch(() => ({}))) as { accounts?: GoogleBusinessAccount[] } & GoogleErrorBody;
    if (!accountsRes.ok) {
      throw new Error(accountsJson.error?.message ?? "Could not list Google Business Profile accounts");
    }
    const account = accountsJson.accounts?.[0];
    if (!account?.name) {
      throw new Error("No Google Business Profile account found on this Google login");
    }

    const locationsRes = await fetch(
      `${LOCATIONS_BASE}/${account.name}/locations?readMask=name,title`,
      { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
    );
    const locationsJson = (await locationsRes.json().catch(() => ({}))) as { locations?: GoogleBusinessLocation[] } & GoogleErrorBody;
    if (!locationsRes.ok) {
      throw new Error(locationsJson.error?.message ?? "Could not list Google Business Profile locations");
    }

    const options: ConnectOption[] = (locationsJson.locations ?? [])
      .filter((l): l is GoogleBusinessLocation & { name: string } => !!l.name)
      .map((l) => ({ id: l.name, name: l.title ?? l.name }));

    // userToken here carries both the access token and the account resource
    // name, JSON-encoded — finalizeConnectOption needs the account name to
    // build the location's full parent path, and PendingConnectSelection
    // only has one string field to carry state through.
    return {
      userToken: JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, accountName: account.name }),
      options,
    };
  }

  async finalizeConnectOption(userToken: string, selectedId: string): Promise<OAuthExchangeResult> {
    const parsed = JSON.parse(userToken) as { accessToken: string; refreshToken: string | null; expiresAt: string | null; accountName: string };
    const locationsRes = await fetch(
      `${LOCATIONS_BASE}/${parsed.accountName}/locations?readMask=name,title`,
      { headers: { Authorization: `Bearer ${parsed.accessToken}` } },
    );
    const locationsJson = (await locationsRes.json().catch(() => ({}))) as { locations?: GoogleBusinessLocation[] };
    const location = locationsJson.locations?.find((l) => l.name === selectedId);
    if (!location) {
      throw new Error("That Google Business Profile location is no longer available — please reconnect");
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      platformAccountId: selectedId, // "locations/{locationId}" -- post() needs the account name too, re-derived via getAccount below
      displayName: location.title ?? selectedId,
    };
  }

  // platformAccountId only carries the location id (see above) -- the
  // account name isn't threaded through PostRequest, so it's re-derived
  // here the same way every other multi-step adapter re-derives what it
  // needs from the access token alone (matches TumblrAdapter's blog-name
  // re-derivation).
  private async getAccountName(accessToken: string): Promise<string> {
    const res = await fetch(ACCOUNTS_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    const json = (await res.json().catch(() => ({}))) as { accounts?: GoogleBusinessAccount[] };
    const name = json.accounts?.[0]?.name;
    if (!name) throw new Error("No Google Business Profile account found");
    return name;
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    if (request.mediaUrl && isVideoUrl(request.mediaUrl)) {
      // Local Posts only document photo media (sourceUrl on a PHOTO
      // MediaItem) -- an honest failure rather than guessing video support
      // exists, same shape as Bluesky's video-post gap.
      return { success: false, platformPostId: null, errorMessage: "Google Business Profile posts don't support video" };
    }

    // Unlike Facebook's page-scoped access tokens (which self-identify which
    // Page they post as), Google's OAuth token is account-level and covers
    // every location on it -- so which location this specific connection is
    // for has to come from social_accounts.platform_account_id (set at
    // connect time by finalizeConnectOption above), looked up here by the
    // one thing PostRequest does carry: socialAccountId. Not stored on
    // PostRequest itself since every other adapter derives what it needs
    // from the access token alone and doesn't need a DB round-trip here.
    const { data: socialAccount, error: lookupError } = await supabase
      .from("social_accounts")
      .select("platform_account_id")
      .eq("id", request.socialAccountId)
      .maybeSingle();
    if (lookupError || !socialAccount?.platform_account_id) {
      return { success: false, platformPostId: null, errorMessage: "Could not resolve which Google Business Profile location this account is connected to" };
    }
    const accountName = await this.getAccountName(request.accessToken);
    const locationId = socialAccount.platform_account_id; // "locations/{id}"

    const body: Record<string, unknown> = {
      languageCode: "en",
      summary: request.content,
      topicType: "STANDARD",
    };
    if (request.mediaUrl) {
      body.media = [{ mediaFormat: "PHOTO", sourceUrl: request.mediaUrl }];
    }

    const res = await fetch(`${LOCAL_POSTS_BASE}/${accountName}/${locationId}/localPosts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${request.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as LocalPost & GoogleErrorBody;
    if (!res.ok || !json.name) {
      return { success: false, platformPostId: null, errorMessage: json.error?.message ?? `Google Business Profile post failed (HTTP ${res.status})` };
    }
    return { success: true, platformPostId: json.name, errorMessage: null };
  }

  async refresh(refreshToken: string): Promise<OAuthExchangeResult> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await res.json()) as GoogleTokenResponse;
    if (!res.ok || !json.access_token) {
      throw new Error(json.error_description ?? json.error ?? "Google token refresh failed");
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? refreshToken,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
      platformAccountId: "",
      displayName: "",
    };
  }

  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const res = await fetch(`${LOCAL_POSTS_BASE}/${platformPostId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json().catch(() => ({}))) as LocalPost & GoogleErrorBody;
    if (!res.ok || json.name !== platformPostId) {
      return { verifiedLive: false, platformPostUrl: null, errorMessage: json.error?.message ?? `Could not verify post (HTTP ${res.status})` };
    }
    return { verifiedLive: true, platformPostUrl: json.searchUrl ?? null, errorMessage: null };
  }
}
