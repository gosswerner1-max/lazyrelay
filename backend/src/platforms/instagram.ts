import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
  PostMetrics,
  CommentPostResult,
  CommentsResult,
  DMConversationsResult,
  DMMessagesResult,
  SendDMResult,
} from "./types.js";

// Instagram Business posting via "Instagram API with Facebook Login" — same
// OAuth app/flow as the Facebook adapter (Facebook Login for Business), but
// the actual posting target is the Instagram Business Account linked to a
// Facebook Page, not the Page itself. All calls go through graph.facebook.com
// (NOT graph.instagram.com — that host is only for the separate "Instagram
// API with Instagram Login" product this app does not use), confirmed via
// Meta's own docs: "For apps using Facebook Login for Business... all
// endpoints are accessed via the graph.facebook.com host."
const AUTHORIZE_URL = "https://www.facebook.com/v25.0/dialog/oauth";
const TOKEN_URL = "https://graph.facebook.com/v25.0/oauth/access_token";
const GRAPH_BASE = "https://graph.facebook.com/v25.0";

// instagram_manage_comments added 2026-08-07 for postComment() (first-comment
// auto-posting) — instagram_content_publish only covers creating the media
// itself, not commenting on it afterward.
const SCOPES = "instagram_basic,instagram_content_publish,instagram_manage_comments,instagram_manage_messages,pages_show_list,pages_read_engagement,business_management";

interface FacebookTokenResponse {
  access_token?: string;
  error?: { message?: string };
}

interface FacebookPage {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string };
}

interface FacebookPagesResponse {
  data?: FacebookPage[];
  error?: { message?: string };
}

interface InstagramUserInfo {
  id?: string;
  username?: string;
  error?: { message?: string };
}

interface InstagramContainerResponse {
  id?: string;
  error?: { message?: string };
}

interface InstagramContainerStatusResponse {
  status_code?: "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";
  error?: { message?: string };
}

interface InstagramMediaResponse {
  id?: string;
  permalink?: string;
  error?: { message?: string };
}

interface InstagramMediaMetricsResponse {
  id?: string;
  like_count?: number;
  comments_count?: number;
  error?: { message?: string };
}

interface InstagramCommentsResponse {
  data?: { id: string; text?: string; username?: string; timestamp?: string }[];
  error?: { message?: string };
}

interface InstagramConversationsResponse {
  data?: {
    id: string;
    updated_time?: string;
    snippet?: string;
    participants?: { data?: { id: string; username?: string }[] };
  }[];
  error?: { message?: string };
}

interface InstagramMessagesResponse {
  data?: { id: string; message?: string; from?: { id: string; username?: string }; created_time?: string }[];
  error?: { message?: string };
}

export class InstagramAdapter implements PlatformAdapter {
  readonly platform: "instagram" = "instagram";

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: SCOPES,
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  private async exchangeForLongLivedUserToken(shortLivedToken: string): Promise<string> {
    const url = new URL(TOKEN_URL);
    url.searchParams.set("grant_type", "fb_exchange_token");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("client_secret", this.clientSecret);
    url.searchParams.set("fb_exchange_token", shortLivedToken);

    const res = await fetch(url.toString());
    const json = (await res.json()) as FacebookTokenResponse;
    if (!res.ok || !json.access_token) {
      throw new Error(json.error?.message ?? "Could not exchange for a long-lived Facebook token");
    }
    return json.access_token;
  }

  // Same "first eligible match" simplification as FacebookAdapter.getFirstPage
  // — picks the first Page that actually has an Instagram Business Account
  // linked, rather than building Page/IG-account selection UI.
  private async getFirstPageWithInstagram(longLivedUserToken: string): Promise<FacebookPage & { instagram_business_account: { id: string } }> {
    const url = new URL(`${GRAPH_BASE}/me/accounts`);
    url.searchParams.set("fields", "id,name,access_token,instagram_business_account");
    url.searchParams.set("access_token", longLivedUserToken);

    const res = await fetch(url.toString());
    const json = (await res.json()) as FacebookPagesResponse;
    if (!res.ok || !json.data) {
      throw new Error(json.error?.message ?? "Could not list this account's Facebook Pages");
    }
    const page = json.data.find((p) => p.instagram_business_account?.id);
    if (!page?.instagram_business_account) {
      throw new Error("No Instagram Business Account linked to any Facebook Page on this account");
    }
    return page as FacebookPage & { instagram_business_account: { id: string } };
  }

  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    const codeUrl = new URL(TOKEN_URL);
    codeUrl.searchParams.set("client_id", this.clientId);
    codeUrl.searchParams.set("client_secret", this.clientSecret);
    codeUrl.searchParams.set("redirect_uri", this.redirectUri);
    codeUrl.searchParams.set("code", code);

    const res = await fetch(codeUrl.toString());
    const json = (await res.json()) as FacebookTokenResponse;
    if (!res.ok || !json.access_token) {
      throw new Error(json.error?.message ?? "Facebook token exchange failed");
    }

    const longLivedUserToken = await this.exchangeForLongLivedUserToken(json.access_token);
    const page = await this.getFirstPageWithInstagram(longLivedUserToken);
    const igId = page.instagram_business_account.id;

    const userInfoUrl = new URL(`${GRAPH_BASE}/${igId}`);
    userInfoUrl.searchParams.set("fields", "username");
    userInfoUrl.searchParams.set("access_token", page.access_token);
    const userRes = await fetch(userInfoUrl.toString());
    const userJson = (await userRes.json()) as InstagramUserInfo;

    return {
      // The linked Page's access token is what authorizes calls against its
      // Instagram Business Account — Instagram itself has no separate token
      // in this flow. Page tokens minted from a long-lived user token do
      // not expire on their own.
      accessToken: page.access_token,
      refreshToken: null,
      expiresAt: null,
      platformAccountId: igId,
      displayName: userJson.username ?? page.name,
    };
  }

  // PostRequest.socialAccountId is LazyRelay's own internal id, not the
  // Instagram account id — same shape as every other adapter here that
  // needs a platform-native id at post time. A Page access token's own
  // /me resolves to the Page node, so requesting instagram_business_account
  // as a field on that call resolves the linked IG id in a single round
  // trip, without re-listing /me/accounts.
  private async getInstagramAccountId(accessToken: string): Promise<string> {
    const url = new URL(`${GRAPH_BASE}/me`);
    url.searchParams.set("fields", "instagram_business_account");
    url.searchParams.set("access_token", accessToken);
    const res = await fetch(url.toString());
    const json = (await res.json()) as { instagram_business_account?: { id: string }; error?: { message?: string } };
    if (!res.ok || !json.instagram_business_account?.id) {
      throw new Error(json.error?.message ?? "Could not resolve the connected Instagram Business Account id");
    }
    return json.instagram_business_account.id;
  }

  // Instagram downloads/processes the image asynchronously after container
  // creation — calling media_publish before status_code reaches FINISHED
  // fails with "Media ID is not available." Poll rather than publish
  // immediately. 10 tries * 3s covers Instagram's typical few-second
  // processing window without hanging the scheduler cycle indefinitely.
  private async waitForContainerReady(containerId: string, accessToken: string): Promise<string | null> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const url = new URL(`${GRAPH_BASE}/${containerId}`);
      url.searchParams.set("fields", "status_code");
      url.searchParams.set("access_token", accessToken);
      const res = await fetch(url.toString());
      const json = (await res.json()) as InstagramContainerStatusResponse;
      if (!res.ok) {
        return json.error?.message ?? `Could not check Instagram container status (HTTP ${res.status})`;
      }
      if (json.status_code === "FINISHED") return null;
      if (json.status_code === "ERROR" || json.status_code === "EXPIRED") {
        return `Instagram media container failed processing (${json.status_code})`;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    return "Instagram media container did not finish processing in time";
  }

  // Two-step publish, same shape as the Threads adapter: create a media
  // container, then publish it as a second call.
  async post(request: PostRequest): Promise<PostAttemptResult> {
    if (!request.mediaUrl) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: "Instagram does not support text-only posts — an image is required",
      };
    }

    const igId = await this.getInstagramAccountId(request.accessToken);

    const containerParams = new URLSearchParams({
      image_url: request.mediaUrl,
      caption: request.content,
      access_token: request.accessToken,
    });
    const containerRes = await fetch(`${GRAPH_BASE}/${igId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: containerParams.toString(),
    });
    const containerJson = (await containerRes.json()) as InstagramContainerResponse;
    if (!containerRes.ok || !containerJson.id) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: containerJson.error?.message ?? `Instagram container creation failed (HTTP ${containerRes.status})`,
      };
    }

    const containerError = await this.waitForContainerReady(containerJson.id, request.accessToken);
    if (containerError) {
      return { success: false, platformPostId: null, errorMessage: containerError };
    }

    const publishParams = new URLSearchParams({
      creation_id: containerJson.id,
      access_token: request.accessToken,
    });
    const publishRes = await fetch(`${GRAPH_BASE}/${igId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: publishParams.toString(),
    });
    const publishJson = (await publishRes.json()) as InstagramMediaResponse;
    if (!publishRes.ok || !publishJson.id) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: publishJson.error?.message ?? `Instagram publish failed (HTTP ${publishRes.status})`,
      };
    }

    return { success: true, platformPostId: publishJson.id, errorMessage: null };
  }

  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const url = new URL(`${GRAPH_BASE}/${platformPostId}`);
    url.searchParams.set("fields", "id,permalink");
    url.searchParams.set("access_token", accessToken);

    const res = await fetch(url.toString());
    const json = (await res.json()) as InstagramMediaResponse;

    if (!res.ok || !json.id) {
      return {
        verifiedLive: false,
        platformPostUrl: null,
        errorMessage: json.error?.message ?? `Instagram post could not be independently confirmed (HTTP ${res.status})`,
      };
    }

    return { verifiedLive: true, platformPostUrl: json.permalink ?? null, errorMessage: null };
  }

  // like_count/comments_count are directly on the media object, covered by
  // the already-granted instagram_basic scope. Shares aren't exposed on
  // this field set at all; view/reach counts need the separate Insights API
  // (a different, not-yet-requested scope) — both stay null, not guessed.
  async getPostMetrics(platformPostId: string, accessToken: string): Promise<PostMetrics> {
    const url = new URL(`${GRAPH_BASE}/${platformPostId}`);
    url.searchParams.set("fields", "like_count,comments_count");
    url.searchParams.set("access_token", accessToken);

    const res = await fetch(url.toString());
    const json = (await res.json().catch(() => ({}))) as InstagramMediaMetricsResponse;

    if (!res.ok || !json.id) {
      return {
        likes: null,
        comments: null,
        shares: null,
        views: null,
        errorMessage: json.error?.message ?? `Could not load metrics (HTTP ${res.status})`,
      };
    }

    return {
      likes: json.like_count ?? null,
      comments: json.comments_count ?? null,
      shares: null,
      views: null,
      errorMessage: null,
    };
  }

  async postComment(platformPostId: string, text: string, accessToken: string): Promise<CommentPostResult> {
    const params = new URLSearchParams({ message: text, access_token: accessToken });
    const res = await fetch(`${GRAPH_BASE}/${platformPostId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };

    if (!res.ok || !json.id) {
      return {
        success: false,
        errorMessage: json.error?.message ?? `Instagram comment failed (HTTP ${res.status})`,
      };
    }

    return { success: true, errorMessage: null };
  }

  // Requires instagram_manage_comments (already granted). Instagram's
  // comment resource has no public permalink field the way Facebook's
  // does — url stays null rather than a guessed/constructed link.
  async getComments(platformPostId: string, accessToken: string): Promise<CommentsResult> {
    const url = new URL(`${GRAPH_BASE}/${platformPostId}/comments`);
    url.searchParams.set("fields", "id,text,username,timestamp");
    url.searchParams.set("access_token", accessToken);

    const res = await fetch(url.toString());
    const json = (await res.json().catch(() => ({}))) as InstagramCommentsResponse;
    if (!res.ok) {
      return { comments: [], errorMessage: json.error?.message ?? `Could not load comments (HTTP ${res.status})` };
    }

    const comments = (json.data ?? []).map((c) => ({
      id: c.id,
      author: c.username ?? "Unknown",
      text: c.text ?? "",
      url: null,
      createdAt: c.timestamp ?? null,
    }));
    return { comments, errorMessage: null };
  }

  // Same reasoning as Facebook's replyToComment — /{id}/comments works
  // identically on a media id or an existing comment id.
  async replyToComment(commentId: string, text: string, accessToken: string): Promise<CommentPostResult> {
    return this.postComment(commentId, text, accessToken);
  }

  // Requires instagram_manage_messages (added to the app 2026-08-07
  // specifically for this). Same Conversations API shape as Facebook,
  // scoped to Instagram via platform=instagram — Meta unified this API
  // across both surfaces.
  async getConversations(accessToken: string): Promise<DMConversationsResult> {
    const igAccountId = await this.getInstagramAccountId(accessToken);
    const url = new URL(`${GRAPH_BASE}/${igAccountId}/conversations`);
    url.searchParams.set("platform", "instagram");
    url.searchParams.set("fields", "participants,updated_time,snippet");
    url.searchParams.set("access_token", accessToken);

    const res = await fetch(url.toString());
    const json = (await res.json().catch(() => ({}))) as InstagramConversationsResponse;
    if (!res.ok) {
      return { conversations: [], errorMessage: json.error?.message ?? `Could not load conversations (HTTP ${res.status})` };
    }

    const conversations = (json.data ?? []).flatMap((c) => {
      if (!c.id) return [];
      const other = c.participants?.data?.find((p) => p.id !== igAccountId);
      return [
        {
          id: c.id,
          participantId: other?.id ?? "",
          participantName: other?.username ?? "Unknown",
          snippet: c.snippet ?? null,
          updatedAt: c.updated_time ?? null,
        },
      ];
    });
    return { conversations, errorMessage: null };
  }

  async getDirectMessages(conversationId: string, accessToken: string): Promise<DMMessagesResult> {
    const url = new URL(`${GRAPH_BASE}/${conversationId}/messages`);
    url.searchParams.set("fields", "id,message,from,created_time");
    url.searchParams.set("access_token", accessToken);

    const res = await fetch(url.toString());
    const json = (await res.json().catch(() => ({}))) as InstagramMessagesResponse;
    if (!res.ok) {
      return { messages: [], errorMessage: json.error?.message ?? `Could not load messages (HTTP ${res.status})` };
    }

    const messages = (json.data ?? []).flatMap((m) => {
      if (!m.id) return [];
      return [
        {
          id: m.id,
          fromId: m.from?.id ?? "",
          fromName: m.from?.username ?? "Unknown",
          text: m.message ?? "",
          createdAt: m.created_time ?? null,
        },
      ];
    });
    return { messages, errorMessage: null };
  }

  // Same 24-hour customer-service messaging window constraint as
  // Facebook's sendDirectMessage — a send outside it fails with a real
  // Graph API error, surfaced honestly rather than hidden.
  async sendDirectMessage(recipientId: string, text: string, accessToken: string): Promise<SendDMResult> {
    const igAccountId = await this.getInstagramAccountId(accessToken);
    const res = await fetch(`${GRAPH_BASE}/${igAccountId}/messages?access_token=${encodeURIComponent(accessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { message_id?: string; error?: { message?: string } };
    if (!res.ok || !json.message_id) {
      return { success: false, errorMessage: json.error?.message ?? `Instagram DM send failed (HTTP ${res.status})` };
    }
    return { success: true, errorMessage: null };
  }

  // Same Private Reply mechanism as Facebook — DMs whoever left the
  // comment without needing them to have messaged the account first.
  async sendPrivateReply(commentId: string, text: string, accessToken: string): Promise<SendDMResult> {
    const res = await fetch(`${GRAPH_BASE}/${commentId}/private_replies?access_token=${encodeURIComponent(accessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!res.ok || !json.id) {
      return { success: false, errorMessage: json.error?.message ?? `Instagram private reply failed (HTTP ${res.status})` };
    }
    return { success: true, errorMessage: null };
  }
}
