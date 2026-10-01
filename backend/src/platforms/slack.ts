import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
  PendingConnectSelection,
} from "./types.js";

// Slack (checked against docs.slack.dev on 2026-10-01). A customer installs the LazyRelay Slack app into one
// workspace (OAuth v2) and the install hands back a BOT token (xoxb-). One connected account is one workspace
// plus ONE public channel, picked after the install (the same pick-one flow Tumblr uses for blogs):
//   platform_account_id = "<team id>:<channel id>"   display_name = "#channel (Workspace)"
// Connecting another channel means connecting again. Reconnecting the same pair updates that account.
//
// Bot tokens do not expire unless the Slack app has token rotation switched on. Both are handled: when the install
// response carries refresh_token and expires_in they are stored and refresh() renews the token, otherwise the token
// is treated as long-lived. Rotation is meant to stay OFF (see the release notes), this is only the safety net.
//
// Posting is chat.postMessage with plain text only (no images in v1, see platformRules). Slack answers almost every
// failure as HTTP 200 {ok:false, error:"..."}; the one exception is rate limiting (HTTP 429 plus Retry-After).
// Error text returned to the scheduler always carries Slack's own error code, because postErrors.ts matches on it.
//
// Proof of publish: chat.postMessage returns the message timestamp (ts). The post is only called live after
// chat.getPermalink confirms that message exists, and the permalink becomes the proof link. conversations.history
// is deliberately never used: since 2025-05-29 apps that are not in the Slack Marketplace may call it only once a
// minute for 15 messages.
const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const API_BASE = "https://slack.com/api";
const TIMEOUT_MS = 30_000;

// Bot scopes. chat:write.public lets the bot post in a public channel it has not been invited to. channels:read lists
// public channels for the picker. No groups:read (private channels are not offered) and no files:write (no images).
export const SLACK_BOT_SCOPES = ["chat:write", "chat:write.public", "channels:read"];

// Slack's own recommendation for the text field. The hard limit is far higher (40,000), 4,000 is what LazyRelay allows.
export const SLACK_TEXT_LIMIT = 4000;
// The picker shows at most this many channels (conversations.list is paged 200 at a time).
const MAX_CHANNELS = 1000;
const PAGE_SIZE = 200;
const MAX_PAGES = 20;

const CHANNEL_ID = /^[A-Z0-9]{1,32}$/;
const TEAM_ID = /^[A-Z0-9]{1,32}$/;
const MESSAGE_TS = /^\d{1,12}\.\d{1,9}$/;

interface SlackReply {
  status: number;
  json: Record<string, unknown>;
  retryAfter: string | null;
}

interface HeldInstall {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  teamId: string;
  teamName: string;
}

interface SlackChannel {
  id: string;
  name: string;
}

/** Slack mrkdwn treats &, < and > as markup: <!channel>, <@U123> and <https://x|label> are mentions and links. Escaping
 *  all three (Slack's documented rule) makes a customer's literal text inert: it can never ping anyone or hide a link
 *  behind other words. Real URLs in the text still become links, Slack unescapes &amp; inside them. */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "<team id>:<channel id>" (the stored platform_account_id) back into its two parts, or null when it is not that. */
export function parseSlackAccountId(value: string | null | undefined): { teamId: string; channelId: string } | null {
  if (!value) return null;
  const [teamId, channelId, extra] = value.split(":");
  if (extra !== undefined || !teamId || !channelId || !TEAM_ID.test(teamId) || !CHANNEL_ID.test(channelId)) return null;
  return { teamId, channelId };
}

// Names that end up in the picker, the connected-account label and ops alerts. Slack restricts channel names itself,
// but this never relies on that: only letters, digits, spaces and a few quiet characters survive.
function safeLabel(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[^\p{L}\p{N}\p{M} _.'-]/gu, "").trim().slice(0, max);
}

function errorCodeOf(reply: SlackReply): string {
  if (reply.status === 429) return "ratelimited";
  const code = reply.json.error;
  if (typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code)) return code;
  return "";
}

function retryAfterSuffix(reply: SlackReply): string {
  const seconds = Number.parseInt(reply.retryAfter ?? "", 10);
  return Number.isFinite(seconds) && seconds > 0 ? ` (Slack asks to wait ${Math.min(seconds, 3600)} seconds)` : "";
}

// What the scheduler gets back. Always carries Slack's own code (postErrors.ts turns it into the plain-language
// reason). Never contains a token: the only inputs are the action name, a validated code and a number.
function failureText(action: string, reply: SlackReply): string {
  const code = errorCodeOf(reply);
  if (!code) return `Slack ${action} failed (HTTP ${reply.status})`;
  return `Slack ${action} failed: ${code}${code === "ratelimited" ? retryAfterSuffix(reply) : ""}`;
}

async function slackCall(
  method: string,
  opts: { token?: string; query?: Record<string, string>; json?: unknown; form?: URLSearchParams },
): Promise<SlackReply> {
  const url = new URL(`${API_BASE}/${method}`);
  for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = opts.form.toString();
  }
  const res = await fetch(url.toString(), {
    method: body === undefined ? "GET" : "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
  } catch {
    // Not JSON (a gateway error page, for example): leave it empty, the status code carries the story.
  }
  return { status: res.status, json, retryAfter: res.headers?.get?.("retry-after") ?? null };
}

const isOk = (reply: SlackReply): boolean => reply.status >= 200 && reply.status < 300 && reply.json.ok === true;

// A network failure or timeout, worded so postErrors.ts treats it as temporary. Never includes the raw error: it can
// quote the request.
const UNREACHABLE = "Could not reach Slack (timed out or network error)";

const INSTALL_ERRORS: Record<string, string> = {
  invalid_code: "That Slack approval was already used or has expired. Please connect Slack again.",
  bad_redirect_uri: "Slack refused the connection because LazyRelay's Slack settings are wrong. We have been told, please try again later.",
  bad_client_secret: "Slack refused the connection because LazyRelay's Slack settings are wrong. We have been told, please try again later.",
  invalid_client_id: "Slack refused the connection because LazyRelay's Slack settings are wrong. We have been told, please try again later.",
  oauth_authorization_url_mismatch: "Slack refused the connection because LazyRelay's Slack settings are wrong. We have been told, please try again later.",
  ratelimited: "Slack is busy right now. Wait a minute and connect again.",
};

export class SlackAdapter implements PlatformAdapter {
  readonly platform: "slack" = "slack";
  // One workspace and ONE channel per connection; a second channel means connecting again.
  readonly singleSelection = true;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      scope: SLACK_BOT_SCOPES.join(","),
      redirect_uri: this.redirectUri,
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  // The install response, validated. The code is single use, so this runs once per connect.
  private async exchange(code: string): Promise<HeldInstall> {
    let reply: SlackReply;
    try {
      reply = await slackCall("oauth.v2.access", {
        form: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, code, redirect_uri: this.redirectUri }),
      });
    } catch {
      throw new Error("Could not reach Slack to finish connecting. Please try again.");
    }
    if (!isOk(reply)) {
      const slackCode = errorCodeOf(reply);
      throw new Error(INSTALL_ERRORS[slackCode] ?? `Slack could not finish connecting${slackCode ? ` (${slackCode})` : ""}. Please try again.`);
    }
    const json = reply.json as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      scope?: unknown;
      is_enterprise_install?: unknown;
      team?: { id?: unknown; name?: unknown } | null;
    };
    if (json.is_enterprise_install === true) {
      throw new Error("LazyRelay connects to one Slack workspace at a time, not a whole Enterprise Grid organization. Install it to a single workspace instead.");
    }
    // Only a bot token is ever accepted: LazyRelay asks for bot scopes and nothing else.
    if (typeof json.access_token !== "string" || !json.access_token.startsWith("xoxb-")) {
      throw new Error("Slack did not return a bot connection for LazyRelay. Please connect again.");
    }
    const teamId = typeof json.team?.id === "string" ? json.team.id : "";
    if (!TEAM_ID.test(teamId)) throw new Error("Slack did not say which workspace this is. Please connect again.");
    if (typeof json.scope === "string") {
      const granted = new Set(json.scope.split(","));
      const missing = SLACK_BOT_SCOPES.filter((s) => !granted.has(s));
      if (missing.length > 0) throw new Error("Slack did not grant every permission LazyRelay needs. Please connect again and allow all of them.");
    }
    return {
      accessToken: json.access_token,
      // Only present when token rotation is on for the Slack app.
      refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : null,
      expiresAt: typeof json.expires_in === "number" && json.expires_in > 0 ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
      teamId,
      teamName: safeLabel(json.team?.name, 80) || "Slack workspace",
    };
  }

  // Public channels of the workspace the token belongs to, paged and capped.
  private async listChannels(accessToken: string): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = [];
    let cursor = "";
    for (let page = 0; page < MAX_PAGES && channels.length < MAX_CHANNELS; page++) {
      const query: Record<string, string> = { types: "public_channel", exclude_archived: "true", limit: String(PAGE_SIZE) };
      if (cursor) query.cursor = cursor;
      let reply: SlackReply;
      try {
        reply = await slackCall("conversations.list", { token: accessToken, query });
      } catch {
        throw new Error("Could not reach Slack to list your channels. Please try again.");
      }
      if (!isOk(reply)) {
        const slackCode = errorCodeOf(reply);
        if (slackCode === "ratelimited") throw new Error("Slack is busy right now. Wait a minute and connect again.");
        throw new Error(`Slack would not list your channels${slackCode ? ` (${slackCode})` : ""}. Please connect again.`);
      }
      const raw = Array.isArray(reply.json.channels) ? (reply.json.channels as Array<Record<string, unknown>>) : [];
      for (const c of raw) {
        if (typeof c.id !== "string" || !CHANNEL_ID.test(c.id) || c.is_archived === true) continue;
        const name = safeLabel(c.name, 80);
        if (!name) continue;
        channels.push({ id: c.id, name });
      }
      const meta = reply.json.response_metadata as { next_cursor?: unknown } | undefined;
      cursor = typeof meta?.next_cursor === "string" ? meta.next_cursor : "";
      if (!cursor) break;
    }
    return channels.slice(0, MAX_CHANNELS).sort((a, z) => a.name.localeCompare(z.name));
  }

  private labelFor(channelName: string, teamName: string): string {
    return `#${channelName} (${teamName})`;
  }

  // connect.ts always uses listConnectOptions below. This exists to satisfy the adapter contract: Slack cannot be
  // connected without choosing a channel, so there is nothing sensible to return here.
  async exchangeCode(): Promise<OAuthExchangeResult> {
    throw new Error("Slack needs a channel to be picked after the install. Please connect Slack again.");
  }

  // The install gives access to the whole workspace; the customer picks the one channel this connection posts to.
  // The login is held server-side (never sent to the browser) until they choose.
  async listConnectOptions(code: string): Promise<PendingConnectSelection> {
    const held = await this.exchange(code);
    const channels = await this.listChannels(held.accessToken);
    if (channels.length === 0) throw new Error("Could not find any public channel in that Slack workspace. Create one in Slack, then connect again.");
    return {
      userToken: JSON.stringify(held),
      options: channels.map((c) => ({ id: `${held.teamId}:${c.id}`, name: this.labelFor(c.name, held.teamName) })),
    };
  }

  async finalizeConnectOption(userToken: string, selectedId: string): Promise<OAuthExchangeResult> {
    let held: HeldInstall;
    try {
      held = JSON.parse(userToken) as HeldInstall;
    } catch {
      throw new Error("The held Slack connection is damaged, please reconnect");
    }
    const target = parseSlackAccountId(selectedId);
    // The workspace always comes from the install LazyRelay is holding, never from the browser: a channel in any
    // other workspace is refused even if its id is well formed.
    if (!target || target.teamId !== held.teamId) throw new Error("That Slack channel is not in the workspace you connected, please reconnect");
    // Re-check against Slack that the chosen channel still exists in this workspace.
    const channels = await this.listChannels(held.accessToken);
    const channel = channels.find((c) => c.id === target.channelId);
    if (!channel) throw new Error("That Slack channel is no longer available, please reconnect");
    return {
      accessToken: held.accessToken,
      refreshToken: held.refreshToken,
      expiresAt: held.expiresAt,
      platformAccountId: `${held.teamId}:${channel.id}`,
      displayName: this.labelFor(channel.name, held.teamName),
    };
  }

  // Only reached when the Slack app has token rotation on (then the install returns a refresh token). The refresh
  // token rotates on every use; scheduler.ts stores the new one.
  async refresh(refreshToken: string): Promise<OAuthExchangeResult> {
    let reply: SlackReply;
    try {
      reply = await slackCall("oauth.v2.access", {
        form: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }),
      });
    } catch {
      throw new Error("Could not reach Slack to renew the connection");
    }
    const json = reply.json as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    if (!isOk(reply) || typeof json.access_token !== "string" || !json.access_token) {
      const slackCode = errorCodeOf(reply);
      // Wording chosen so tokenHealth.isPermanentAuthError() recognises a dead grant.
      if (slackCode === "invalid_refresh_token" || slackCode === "token_revoked" || slackCode === "invalid_grant_type") {
        throw new Error("Slack refresh token is invalid or has been revoked");
      }
      throw new Error(`Slack token renewal failed${slackCode ? ` (${slackCode})` : ` (HTTP ${reply.status})`}`);
    }
    return {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : null,
      expiresAt: typeof json.expires_in === "number" && json.expires_in > 0 ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
      platformAccountId: "",
      displayName: "",
    };
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const fail = (errorMessage: string): PostAttemptResult => ({ success: false, platformPostId: null, errorMessage });

    const target = parseSlackAccountId(request.platformAccountId);
    if (!target) return fail("Slack channel_not_found: this connection has no channel saved");
    if (request.mediaUrl || (request.mediaUrls?.length ?? 0) > 0) {
      return fail("Slack posts through LazyRelay are text only (unsupported media): remove the image or video");
    }
    const content = request.content.trim();
    if (!content) return fail("Slack post failed: no_text");
    if (content.length > SLACK_TEXT_LIMIT) return fail("Slack post failed: msg_too_long");

    let reply: SlackReply;
    try {
      reply = await slackCall("chat.postMessage", {
        token: request.accessToken,
        json: {
          channel: target.channelId,
          text: escapeSlackText(content),
          // A marketing post wants its links to show a preview.
          unfurl_links: true,
          unfurl_media: true,
        },
      });
    } catch {
      return fail(UNREACHABLE);
    }
    if (!isOk(reply)) return fail(failureText("post", reply));

    const channel = typeof reply.json.channel === "string" ? reply.json.channel : "";
    const ts = typeof reply.json.ts === "string" ? reply.json.ts : "";
    if (!CHANNEL_ID.test(channel) || !MESSAGE_TS.test(ts)) {
      return fail("Slack accepted the post but did not return a message id");
    }
    // verifyPublished only gets this string, so it carries both halves of the message's address.
    return { success: true, platformPostId: `${channel}:${ts}`, errorMessage: null };
  }

  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const [channel, ts, extra] = platformPostId.split(":");
    if (extra !== undefined || !channel || !ts || !CHANNEL_ID.test(channel) || !MESSAGE_TS.test(ts)) {
      return { verifiedLive: false, platformPostUrl: null, errorMessage: `Not a valid Slack post id: ${platformPostId.slice(0, 60)}` };
    }
    let reply: SlackReply;
    try {
      reply = await slackCall("chat.getPermalink", { token: accessToken, query: { channel, message_ts: ts } });
    } catch {
      return { verifiedLive: false, platformPostUrl: null, errorMessage: UNREACHABLE };
    }
    if (!isOk(reply)) {
      return { verifiedLive: false, platformPostUrl: null, errorMessage: failureText("confirmation", reply) };
    }
    const permalink = typeof reply.json.permalink === "string" ? reply.json.permalink : "";
    // The link is published as the customer's proof, so it is only trusted when it is https on Slack's own domain.
    let safe: string | null = null;
    try {
      const u = new URL(permalink);
      if (u.protocol === "https:" && (u.hostname === "slack.com" || u.hostname.endsWith(".slack.com")) && !u.username && !u.password) safe = u.toString();
    } catch {
      safe = null;
    }
    if (!safe) {
      return { verifiedLive: false, platformPostUrl: null, errorMessage: "Slack confirmed the message but returned an unexpected link, so it could not be confirmed yet" };
    }
    return { verifiedLive: true, platformPostUrl: safe, errorMessage: null };
  }
}
