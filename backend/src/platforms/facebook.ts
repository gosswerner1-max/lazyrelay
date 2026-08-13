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
  ConnectOption,
  PendingConnectSelection,
} from "./types.js";

// A Facebook user can manage multiple Pages. exchangeCode() below still
// connects the FIRST Page returned by /me/accounts, kept for interface
// compliance and any direct caller that doesn't care which Page — the real
// connect flow (connect.ts) prefers listConnectOptions/finalizeConnectOption
// instead, which let the customer actually pick when there's more than one.
const AUTHORIZE_URL = "https://www.facebook.com/v25.0/dialog/oauth";
const TOKEN_URL = "https://graph.facebook.com/v25.0/oauth/access_token";
const GRAPH_BASE = "https://graph.facebook.com/v25.0";

// pages_manage_engagement added 2026-08-07 for postComment() (first-comment
// auto-posting) — a distinct permission from pages_manage_posts, which only
// covers creating the post itself, not commenting on it.
const SCOPES = "pages_show_list,pages_read_engagement,pages_manage_posts,pages_manage_engagement,pages_read_user_content,pages_messaging,business_management";

interface FacebookTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: { message?: string };
}

interface FacebookPage {
  id: string;
  name: string;
  access_token: string;
}

interface FacebookPagesResponse {
  data?: FacebookPage[];
  error?: { message?: string };
}

interface FacebookPostResponse {
  id?: string;
  post_id?: string;
  error?: { message?: string };
}

interface FacebookPostDetail {
  id?: string;
  permalink_url?: string;
  error?: { message?: string };
}

interface FacebookPostMetricsResponse {
  id?: string;
  likes?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
  error?: { message?: string };
}

interface FacebookCommentsResponse {
  data?: { id: string; message?: string; from?: { name?: string }; created_time?: string; permalink_url?: string }[];
  error?: { message?: string };
}

interface FacebookConversationsResponse {
  data?: {
    id: string;
    updated_time?: string;
    snippet?: string;
    participants?: { data?: { id: string; name?: string }[] };
  }[];
  error?: { message?: string };
}

interface FacebookMessagesResponse {
  data?: { id: string; message?: string; from?: { id: string; name?: string }; created_time?: string }[];
  error?: { message?: string };
}

export class FacebookAdapter implements PlatformAdapter {
  readonly platform: "facebook" = "facebook";

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

  protected async getPages(longLivedUserToken: string): Promise<FacebookPage[]> {
    const url = new URL(`${GRAPH_BASE}/me/accounts`);
    url.searchParams.set("fields", "id,name,access_token,instagram_business_account");
    url.searchParams.set("access_token", longLivedUserToken);

    const res = await fetch(url.toString());
    const json = (await res.json()) as FacebookPagesResponse;
    if (!res.ok || !json.data) {
      throw new Error(json.error?.message ?? "Could not list this account's Facebook Pages");
    }
    if (json.data.length === 0) {
      throw new Error("No Facebook Page found — this account must manage at least one Page to connect");
    }
    return json.data;
  }

  private async exchangeCodeForUserToken(code: string): Promise<string> {
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
    return await this.exchangeForLongLivedUserToken(json.access_token);
  }

  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    const longLivedUserToken = await this.exchangeCodeForUserToken(code);
    const [page] = await this.getPages(longLivedUserToken);

    return {
      // Page access tokens minted from a long-lived user token do not
      // expire on their own — confirmed Meta behavior, distinct from the
      // user token they're derived from.
      accessToken: page.access_token,
      refreshToken: null,
      expiresAt: null,
      platformAccountId: page.id,
      displayName: page.name,
    };
  }

  // Real picker path (connect.ts prefers this over exchangeCode). Returns
  // every Page the account manages instead of silently picking the first.
  async listConnectOptions(code: string): Promise<PendingConnectSelection> {
    const userToken = await this.exchangeCodeForUserToken(code);
    const pages = await this.getPages(userToken);
    return { userToken, options: pages.map((p): ConnectOption => ({ id: p.id, name: p.name })) };
  }

  // Re-lists the account's Pages against the held user token (not trusted
  // from the client) and finalizes with whichever id the customer actually
  // picked.
  async finalizeConnectOption(userToken: string, selectedId: string): Promise<OAuthExchangeResult> {
    const pages = await this.getPages(userToken);
    const page = pages.find((p) => p.id === selectedId);
    if (!page) {
      throw new Error("That Facebook Page is no longer available — please reconnect");
    }
    return {
      accessToken: page.access_token,
      refreshToken: null,
      expiresAt: null,
      platformAccountId: page.id,
      displayName: page.name,
    };
  }

  private async getPageId(pageAccessToken: string): Promise<string> {
    const url = new URL(`${GRAPH_BASE}/me`);
    url.searchParams.set("fields", "id");
    url.searchParams.set("access_token", pageAccessToken);
    const res = await fetch(url.toString());
    const json = (await res.json()) as { id?: string; error?: { message?: string } };
    if (!res.ok || !json.id) {
      throw new Error(json.error?.message ?? "Could not resolve the connected Facebook Page's id");
    }
    return json.id;
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const pageId = await this.getPageId(request.accessToken);

    const isVideo = request.mediaUrl ? /\.(mp4|mov|avi|mkv|webm|m4v|3gp|ogv|flv|wmv)(\?|#|$)/i.test(request.mediaUrl) : false;
    const params = new URLSearchParams({ access_token: request.accessToken });
    let endpoint: string;
    if (isVideo) {
      endpoint = `${GRAPH_BASE}/${pageId}/videos`;
      params.set("file_url", request.mediaUrl!);
      params.set("description", request.content);
    } else if (request.mediaUrl) {
      endpoint = `${GRAPH_BASE}/${pageId}/photos`;
      params.set("url", request.mediaUrl);
      params.set("caption", request.content);
    } else {
      endpoint = `${GRAPH_BASE}/${pageId}/feed`;
      params.set("message", request.content);
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const json = (await res.json()) as FacebookPostResponse;

    // Photo posts return { id, post_id } where post_id is the Page post id.
    // Video posts return { id } only — the video id IS the Page post id.
    const postId = json.post_id ?? json.id;
    if (!res.ok || !postId) {
      return {
        success: false,
        platformPostId: null,
        errorMessage: json.error?.message ?? `Facebook post failed (HTTP ${res.status})`,
      };
    }

    return { success: true, platformPostId: postId, errorMessage: null };
  }

  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const url = new URL(`${GRAPH_BASE}/${platformPostId}`);
    url.searchParams.set("fields", "id,permalink_url");
    url.searchParams.set("access_token", accessToken);

    const res = await fetch(url.toString());
    const json = (await res.json()) as FacebookPostDetail;

    if (!res.ok || !json.id) {
      return {
        verifiedLive: false,
        platformPostUrl: null,
        errorMessage: json.error?.message ?? `Facebook post could not be independently confirmed (HTTP ${res.status})`,
      };
    }

    return { verifiedLive: true, platformPostUrl: json.permalink_url ?? null, errorMessage: null };
  }

  // Basic post-field counts only (likes/comments/shares) — already covered
  // by the granted pages_read_engagement scope. View/impression counts need
  // the separate Page Insights API (a different, not-yet-requested scope),
  // so views stays null rather than guessed or silently omitted.
  async getPostMetrics(platformPostId: string, accessToken: string): Promise<PostMetrics> {
    const url = new URL(`${GRAPH_BASE}/${platformPostId}`);
    url.searchParams.set("fields", "likes.summary(true),comments.summary(true),shares");
    url.searchParams.set("access_token", accessToken);

    const res = await fetch(url.toString());
    const json = (await res.json().catch(() => ({}))) as FacebookPostMetricsResponse;

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
      likes: json.likes?.summary?.total_count ?? null,
      comments: json.comments?.summary?.total_count ?? null,
      shares: json.shares?.count ?? null,
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
        errorMessage: json.error?.message ?? `Facebook comment failed (HTTP ${res.status})`,
      };
    }

    return { success: true, errorMessage: null };
  }

  // Requires pages_read_engagement (already granted) — comments on a Page
  // post the connected account manages.
  async getComments(platformPostId: string, accessToken: string): Promise<CommentsResult> {
    const url = new URL(`${GRAPH_BASE}/${platformPostId}/comments`);
    url.searchParams.set("fields", "id,message,from,created_time,permalink_url");
    url.searchParams.set("access_token", accessToken);

    const res = await fetch(url.toString());
    const json = (await res.json().catch(() => ({}))) as FacebookCommentsResponse;
    if (!res.ok) {
      return { comments: [], errorMessage: json.error?.message ?? `Could not load comments (HTTP ${res.status})` };
    }

    const comments = (json.data ?? []).map((c) => ({
      id: c.id,
      author: c.from?.name ?? "Unknown",
      text: c.message ?? "",
      url: c.permalink_url ?? null,
      createdAt: c.created_time ?? null,
    }));
    return { comments, errorMessage: null };
  }

  // Graph API's /{id}/comments endpoint works identically whether {id} is a
  // post or an existing comment — a reply IS just a comment whose parent
  // happens to be another comment, so this reuses postComment's exact
  // shape rather than duplicating it under a different name.
  async replyToComment(commentId: string, text: string, accessToken: string): Promise<CommentPostResult> {
    return this.postComment(commentId, text, accessToken);
  }

  // Requires pages_messaging (added to the app 2026-08-07 specifically for
  // this). participants.data includes the Page itself alongside whoever
  // messaged it — the customer is whichever participant id isn't the Page's
  // own, resolved via the same getPageId() post() already uses.
  async getConversations(accessToken: string): Promise<DMConversationsResult> {
    const pageId = await this.getPageId(accessToken);
    const url = new URL(`${GRAPH_BASE}/${pageId}/conversations`);
    url.searchParams.set("fields", "participants,updated_time,snippet");
    url.searchParams.set("access_token", accessToken);

    const res = await fetch(url.toString());
    const json = (await res.json().catch(() => ({}))) as FacebookConversationsResponse;
    if (!res.ok) {
      return { conversations: [], errorMessage: json.error?.message ?? `Could not load conversations (HTTP ${res.status})` };
    }

    const conversations = (json.data ?? []).flatMap((c) => {
      if (!c.id) return [];
      const other = c.participants?.data?.find((p) => p.id !== pageId);
      return [
        {
          id: c.id,
          participantId: other?.id ?? "",
          participantName: other?.name ?? "Unknown",
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
    const json = (await res.json().catch(() => ({}))) as FacebookMessagesResponse;
    if (!res.ok) {
      return { messages: [], errorMessage: json.error?.message ?? `Could not load messages (HTTP ${res.status})` };
    }

    const messages = (json.data ?? []).flatMap((m) => {
      if (!m.id) return [];
      return [
        {
          id: m.id,
          fromId: m.from?.id ?? "",
          fromName: m.from?.name ?? "Unknown",
          text: m.message ?? "",
          createdAt: m.created_time ?? null,
        },
      ];
    });
    return { messages, errorMessage: null };
  }

  // Meta enforces a real 24-hour customer-service messaging window here —
  // messaging_type: "RESPONSE" only works within that window (outside a
  // small set of pre-approved tags this codebase doesn't implement). A
  // send outside the window fails with a real Graph API error, surfaced
  // via errorMessage exactly as returned, not hidden or retried.
  async sendDirectMessage(recipientId: string, text: string, accessToken: string): Promise<SendDMResult> {
    const pageId = await this.getPageId(accessToken);
    const res = await fetch(`${GRAPH_BASE}/${pageId}/messages?access_token=${encodeURIComponent(accessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
        messaging_type: "RESPONSE",
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { message_id?: string; error?: { message?: string } };
    if (!res.ok || !json.message_id) {
      return { success: false, errorMessage: json.error?.message ?? `Facebook DM send failed (HTTP ${res.status})` };
    }
    return { success: true, errorMessage: null };
  }

  // Private Replies are Meta's own sanctioned mechanism for DMing someone
  // who merely commented, bypassing the regular 24h-since-they-messaged-us
  // window sendDirectMessage is bound by. Meta enforces its own eligibility
  // window here too (comments older than ~7 days can no longer be
  // privately replied to) — a request outside it returns a real API
  // error, surfaced honestly rather than retried forever.
  async sendPrivateReply(commentId: string, text: string, accessToken: string): Promise<SendDMResult> {
    const res = await fetch(`${GRAPH_BASE}/${commentId}/private_replies?access_token=${encodeURIComponent(accessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!res.ok || !json.id) {
      return { success: false, errorMessage: json.error?.message ?? `Facebook private reply failed (HTTP ${res.status})` };
    }
    return { success: true, errorMessage: null };
  }
}
