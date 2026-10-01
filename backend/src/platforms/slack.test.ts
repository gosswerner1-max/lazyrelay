// Slack adapter: fetch is stubbed, nothing real is called and no Slack credentials are used.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// tokenHealth.ts (read for isPermanentAuthError) imports supabase.ts, which throws without env vars. Nothing here
// touches a database.
vi.mock("../supabase.js", () => ({ supabase: { from: () => ({}) } }));

const { SlackAdapter, escapeSlackText, parseSlackAccountId, SLACK_BOT_SCOPES, SLACK_TEXT_LIMIT } = await import("./slack.js");
const { classifyPostError } = await import("../postErrors.js");
const { isPermanentAuthError } = await import("../tokenHealth.js");
import type { PostRequest } from "./types.js";

// Built in pieces so secret scanners do not mistake these obvious test placeholders for real credentials.
const BOT_TOKEN = ["xoxb", "test", "placeholder", "token", "0123456789"].join("-");
const REFRESH_TOKEN = ["xoxe", "1", "test", "placeholder", "refresh"].join("-");
const CLIENT_SECRET = ["test", "client", "secret", "placeholder"].join("-");
const CODE = ["test", "oauth", "code", "placeholder"].join("-");
const REDIRECT = "https://api.example.org/api/social-accounts/callback";

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const adapter = () => new SlackAdapter("client-id-1", CLIENT_SECRET, REDIRECT);

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const urlOf = (call: unknown[]) => new URL(String(call[0]));
const initOf = (call: unknown[]) => call[1] as RequestInit;
const sentJson = (call: unknown[]) => JSON.parse(initOf(call).body as string);
const sentForm = (call: unknown[]) => new URLSearchParams(initOf(call).body as string);

const INSTALL_OK = {
  ok: true,
  access_token: BOT_TOKEN,
  scope: "chat:write,chat:write.public,channels:read",
  bot_user_id: "U0BOT",
  team: { id: "T0001", name: "Acme Corp" },
  authed_user: { id: "U0USER" },
};
const channel = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, is_channel: true, is_archived: false, ...extra });

// ---------------------------------------------------------------------------------------------------------------
describe("connect: authorize link", () => {
  it("sends the customer to Slack's OAuth v2 page with bot scopes, the redirect and the state, and no secret", async () => {
    const url = new URL(await adapter().getAuthorizeUrl("state-123"));
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id-1");
    expect(url.searchParams.get("scope")).toBe("chat:write,chat:write.public,channels:read");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.has("user_scope")).toBe(false);
    expect(url.toString()).not.toContain(CLIENT_SECRET);
  });

  it("asks for the minimum scopes: no private-channel, no file and no user scopes", () => {
    expect(SLACK_BOT_SCOPES).toEqual(["chat:write", "chat:write.public", "channels:read"]);
    expect(SLACK_BOT_SCOPES.join(",")).not.toMatch(/groups|files|history|users/);
  });

  it("is a pick-one connect (one workspace and one channel per connection)", () => {
    expect(adapter().singleSelection).toBe(true);
    expect(adapter().skipConnectConfirmation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("connect: code exchange", () => {
  const listOk = (channels: unknown[], next = "") => reply(200, { ok: true, channels, response_metadata: { next_cursor: next } });

  it("exchanges the code over a POST body (never the address) and keeps the bot token inside the held login", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, INSTALL_OK)).mockResolvedValueOnce(listOk([channel("C1", "general")]));
    const r = await adapter().listConnectOptions(CODE);
    const [url, init] = [urlOf(fetchMock.mock.calls[0]), initOf(fetchMock.mock.calls[0])];
    expect(url.toString()).toBe("https://slack.com/api/oauth.v2.access");
    expect(init.method).toBe("POST");
    const form = sentForm(fetchMock.mock.calls[0]);
    expect(form.get("code")).toBe(CODE);
    expect(form.get("client_id")).toBe("client-id-1");
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(form.get("redirect_uri")).toBe(REDIRECT);
    expect(url.search).toBe(""); // nothing secret in the address
    expect(JSON.parse(r.userToken)).toMatchObject({ accessToken: BOT_TOKEN, refreshToken: null, expiresAt: null, teamId: "T0001", teamName: "Acme Corp" });
    expect(JSON.stringify(r.options)).not.toContain(BOT_TOKEN);
  });

  it("stores the refresh token and expiry when the Slack app has token rotation on, and treats the token as long-lived when not", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, { ...INSTALL_OK, refresh_token: REFRESH_TOKEN, expires_in: 43200 }))
      .mockResolvedValueOnce(listOk([channel("C1", "general")]));
    const rotating = JSON.parse((await adapter().listConnectOptions(CODE)).userToken);
    expect(rotating.refreshToken).toBe(REFRESH_TOKEN);
    expect(new Date(rotating.expiresAt).getTime()).toBeGreaterThan(Date.now() + 11 * 3600_000);

    fetchMock.mockResolvedValueOnce(reply(200, INSTALL_OK)).mockResolvedValueOnce(listOk([channel("C1", "general")]));
    const plain = JSON.parse((await adapter().listConnectOptions(CODE)).userToken);
    expect(plain.refreshToken).toBeNull();
    expect(plain.expiresAt).toBeNull();
  });

  const failures: Array<[string, () => Response | Error, RegExp]> = [
    ["a used or expired code", () => reply(200, { ok: false, error: "invalid_code" }), /already used or has expired/],
    ["a bad client secret (ours)", () => reply(200, { ok: false, error: "bad_client_secret" }), /settings are wrong/],
    ["a redirect that does not match (ours)", () => reply(200, { ok: false, error: "bad_redirect_uri" }), /settings are wrong/],
    ["a wrong client id (ours)", () => reply(200, { ok: false, error: "invalid_client_id" }), /settings are wrong/],
    ["rate limiting", () => reply(429, "", { "retry-after": "30" }), /busy right now/],
    ["a gateway error page", () => reply(502, "<html>Bad gateway</html>"), /Slack could not finish connecting/],
    ["an unknown Slack code", () => reply(200, { ok: false, error: "something_new" }), /something_new/],
    ["a network failure", () => new Error(`connect ECONNRESET while sending ${CLIENT_SECRET} ${CODE}`), /Could not reach Slack/],
    ["a user token instead of a bot token", () => reply(200, { ...INSTALL_OK, access_token: "xoxp-user-token" }), /did not return a bot connection/],
    ["no token at all", () => reply(200, { ok: true, team: { id: "T0001" } }), /did not return a bot connection/],
    ["no workspace id", () => reply(200, { ...INSTALL_OK, team: null }), /did not say which workspace/],
    ["a workspace id with odd characters", () => reply(200, { ...INSTALL_OK, team: { id: "T1:C9", name: "x" } }), /did not say which workspace/],
    ["an Enterprise Grid org-wide install", () => reply(200, { ...INSTALL_OK, is_enterprise_install: true }), /one Slack workspace at a time/],
    ["a missing permission", () => reply(200, { ...INSTALL_OK, scope: "chat:write" }), /did not grant every permission/],
  ];
  it.each(failures)("refuses %s with a plain message and no secret in it", async (_name, make, expected) => {
    const made = make();
    if (made instanceof Error) fetchMock.mockRejectedValueOnce(made);
    else fetchMock.mockResolvedValueOnce(made);
    const err = (await adapter().listConnectOptions(CODE).catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(expected);
    for (const secret of [CLIENT_SECRET, CODE, BOT_TOKEN]) expect(err.message).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledTimes(1); // nothing is listed after a failed install
  });

  it("exchangeCode on its own is never a way to connect (a channel must be picked)", async () => {
    await expect(adapter().exchangeCode()).rejects.toThrow(/channel/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("connect: the channel picker", () => {
  const install = () => reply(200, INSTALL_OK);
  const page = (channels: unknown[], next = "") => reply(200, { ok: true, channels, response_metadata: { next_cursor: next } });

  it("lists public, non-archived channels from the first page, sorted, labelled with the workspace", async () => {
    fetchMock.mockResolvedValueOnce(install()).mockResolvedValueOnce(page([channel("C2", "random"), channel("C1", "general"), channel("C3", "old", { is_archived: true })]));
    const r = await adapter().listConnectOptions(CODE);
    expect(r.options).toEqual([
      { id: "T0001:C1", name: "#general (Acme Corp)" },
      { id: "T0001:C2", name: "#random (Acme Corp)" },
    ]);
    const list = fetchMock.mock.calls[1];
    const u = urlOf(list);
    expect(u.origin + u.pathname).toBe("https://slack.com/api/conversations.list");
    expect(u.searchParams.get("types")).toBe("public_channel");
    expect(u.searchParams.get("exclude_archived")).toBe("true");
    expect(u.searchParams.get("limit")).toBe("200");
    expect(u.searchParams.has("cursor")).toBe(false);
    expect((initOf(list).headers as Record<string, string>).Authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(u.toString()).not.toContain(BOT_TOKEN); // never in the address
  });

  it("follows the cursor across pages", async () => {
    fetchMock
      .mockResolvedValueOnce(install())
      .mockResolvedValueOnce(page([channel("C1", "alpha")], "cursor-two"))
      .mockResolvedValueOnce(page([channel("C2", "bravo")], "cursor-three"))
      .mockResolvedValueOnce(page([channel("C3", "charlie")], ""));
    const r = await adapter().listConnectOptions(CODE);
    expect(r.options.map((o) => o.id)).toEqual(["T0001:C1", "T0001:C2", "T0001:C3"]);
    expect(urlOf(fetchMock.mock.calls[2]).searchParams.get("cursor")).toBe("cursor-two");
    expect(urlOf(fetchMock.mock.calls[3]).searchParams.get("cursor")).toBe("cursor-three");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("stops at about 1,000 channels however many pages Slack offers", async () => {
    let n = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("oauth.v2.access")) return install();
      const chans = Array.from({ length: 200 }, () => channel(`C${String(++n).padStart(5, "0")}`, `chan-${n}`));
      return page(chans, `next-${n}`);
    });
    const r = await adapter().listConnectOptions(CODE);
    expect(r.options).toHaveLength(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1 + 5); // the install plus five pages of 200
  });

  it("cleans channel and workspace names so they can never carry markup or a mention into a page or an alert", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, { ...INSTALL_OK, team: { id: "T0001", name: "Acme <b>Corp</b> <!channel>" } }))
      .mockResolvedValueOnce(page([channel("C1", "<script>alert(1)</script>&x"), channel("C2", "ok_name-1")]));
    const r = await adapter().listConnectOptions(CODE);
    for (const o of r.options) expect(o.name).not.toMatch(/[<>&!]/);
    expect(r.options.map((o) => o.name)).toContain("#ok_name-1 (Acme bCorpb channel)");
  });

  it("skips entries whose id is not a plain Slack id, so a channel id can never carry the ':' that separates the parts", async () => {
    fetchMock.mockResolvedValueOnce(install()).mockResolvedValueOnce(page([channel("C1:T9", "evil"), channel("lowercase", "bad"), channel("C7", "good")]));
    const r = await adapter().listConnectOptions(CODE);
    expect(r.options.map((o) => o.id)).toEqual(["T0001:C7"]);
  });

  it("explains a workspace with no public channel, and Slack rate limiting or errors while listing", async () => {
    fetchMock.mockResolvedValueOnce(install()).mockResolvedValueOnce(page([]));
    await expect(adapter().listConnectOptions(CODE)).rejects.toThrow(/any public channel/);
    fetchMock.mockResolvedValueOnce(install()).mockResolvedValueOnce(reply(429, "", { "retry-after": "10" }));
    await expect(adapter().listConnectOptions(CODE)).rejects.toThrow(/busy right now/);
    fetchMock.mockResolvedValueOnce(install()).mockResolvedValueOnce(reply(200, { ok: false, error: "missing_scope" }));
    await expect(adapter().listConnectOptions(CODE)).rejects.toThrow(/would not list your channels \(missing_scope\)/);
    fetchMock.mockResolvedValueOnce(install()).mockRejectedValueOnce(new Error("socket hang up"));
    await expect(adapter().listConnectOptions(CODE)).rejects.toThrow(/Could not reach Slack to list/);
  });

  describe("finalizing", () => {
    const held = (over: Record<string, unknown> = {}) =>
      JSON.stringify({ accessToken: BOT_TOKEN, refreshToken: null, expiresAt: null, teamId: "T0001", teamName: "Acme Corp", ...over });
    // A fresh Response each call: a body can only be read once.
    const channelsNow = () => fetchMock.mockImplementation(async () => page([channel("C1", "general"), channel("C2", "random")]));

    it("stores the CHOSEN channel as '<team>:<channel>' with a readable label", async () => {
      channelsNow();
      const r = await adapter().finalizeConnectOption(held(), "T0001:C2");
      expect(r).toEqual({ accessToken: BOT_TOKEN, refreshToken: null, expiresAt: null, platformAccountId: "T0001:C2", displayName: "#random (Acme Corp)" });
    });

    it("gives the same account key every time for the same workspace and channel (a reconnect updates, never duplicates)", async () => {
      channelsNow();
      const a = await adapter().finalizeConnectOption(held({ accessToken: "xoxb-first-install" }), "T0001:C1");
      const b = await adapter().finalizeConnectOption(held({ accessToken: "xoxb-second-install" }), "T0001:C1");
      expect(a.platformAccountId).toBe(b.platformAccountId);
      expect(a.displayName).toBe(b.displayName);
    });

    it("carries rotation details through", async () => {
      channelsNow();
      const r = await adapter().finalizeConnectOption(held({ refreshToken: REFRESH_TOKEN, expiresAt: "2026-10-02T00:00:00.000Z" }), "T0001:C1");
      expect(r).toMatchObject({ refreshToken: REFRESH_TOKEN, expiresAt: "2026-10-02T00:00:00.000Z" });
    });

    it("refuses a channel in a workspace the customer did not authorize, even with a well-formed id", async () => {
      channelsNow();
      await expect(adapter().finalizeConnectOption(held(), "T9999:C1")).rejects.toThrow(/not in the workspace you connected/);
      expect(fetchMock).not.toHaveBeenCalled(); // refused before anything is asked of Slack
    });

    it("refuses malformed ids and channels that are gone", async () => {
      channelsNow();
      for (const bad of ["C1", "T0001:", ":C1", "T0001:C1:extra", "t0001:c1", "T0001:C1;drop", ""]) {
        await expect(adapter().finalizeConnectOption(held(), bad)).rejects.toThrow(/not in the workspace you connected/);
      }
      await expect(adapter().finalizeConnectOption(held(), "T0001:C404")).rejects.toThrow(/no longer available/);
    });

    it("refuses a damaged held login", async () => {
      await expect(adapter().finalizeConnectOption("{not json", "T0001:C1")).rejects.toThrow(/damaged/);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("account id helpers", () => {
  it("parses '<team>:<channel>' and nothing else", () => {
    expect(parseSlackAccountId("T0001:C0123")).toEqual({ teamId: "T0001", channelId: "C0123" });
    for (const bad of [null, undefined, "", "C1", "T1:C1:x", "T1:c1", "T 1:C1", "T1:C1/../x"]) expect(parseSlackAccountId(bad as string | null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("escaping: the customer's text can never be read as Slack markup", () => {
  it("escapes &, < and > (Slack's rule) and nothing else", () => {
    expect(escapeSlackText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    expect(escapeSlackText("*bold* _it_ `code` @channel #general")).toBe("*bold* _it_ `code` @channel #general");
    expect(escapeSlackText("&lt;")).toBe("&amp;lt;"); // already-escaped text is escaped again, so it displays as typed
  });

  it("leaves no angle bracket and no bare ampersand in the output, whatever the input", () => {
    for (const text of ["<!channel>", "<!here|here>", "<!everyone>", "<@U123>", "<#C123|general>", "<https://evil.example|click>", "<!subteam^S123>", "a<b>c&d&amp;e", "<<>>"]) {
      const out = escapeSlackText(text);
      expect(out).not.toMatch(/[<>]/);
      expect(out.replace(/&(amp|lt|gt);/g, "")).not.toContain("&");
    }
  });

  it("sends '<!channel>', '<!here>', '<@U123>' and a hidden link as inert text, and a typed @channel as plain text", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, channel: "C1", ts: "1700000000.000100" }));
    const text = "Hi <!channel> <!here> <!everyone> <@U123> <#C123|general> <https://evil.example|safe link> and @channel @here";
    await adapter().post(req({ content: text }));
    const sent = sentJson(fetchMock.mock.calls[0]);
    expect(sent.text).toBe("Hi &lt;!channel&gt; &lt;!here&gt; &lt;!everyone&gt; &lt;@U123&gt; &lt;#C123|general&gt; &lt;https://evil.example|safe link&gt; and @channel @here");
    expect(sent.text).not.toMatch(/[<>]/);
    // No option that would make Slack auto-link names or parse mentions in the text.
    expect(sent).not.toHaveProperty("link_names");
    expect(sent).not.toHaveProperty("parse");
  });
});

// ---------------------------------------------------------------------------------------------------------------
function req(over: Partial<PostRequest> = {}): PostRequest {
  return { socialAccountId: "sa1", platformAccountId: "T0001:C0123", content: "Hello Slack", mediaUrl: null, coverImageUrl: null, accessToken: BOT_TOKEN, ...over };
}

describe("posting", () => {
  it("posts plain text to the saved channel and returns an id that carries channel and ts", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, channel: "C0123", ts: "1700000000.000100", message: { text: "Hello Slack" } }));
    const r = await adapter().post(req());
    expect(r).toEqual({ success: true, platformPostId: "C0123:1700000000.000100", errorMessage: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(urlOf(call).toString()).toBe("https://slack.com/api/chat.postMessage");
    expect(initOf(call).method).toBe("POST");
    expect((initOf(call).headers as Record<string, string>).Authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(String((initOf(call).headers as Record<string, string>)["Content-Type"])).toMatch(/application\/json/);
    expect(sentJson(call)).toEqual({ channel: "C0123", text: "Hello Slack", unfurl_links: true, unfurl_media: true });
    expect(String(call[0])).not.toContain(BOT_TOKEN);
  });

  it("allows exactly 4,000 characters and refuses 4,001 before calling Slack", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, channel: "C0123", ts: "1700000000.000100" }));
    expect((await adapter().post(req({ content: "x".repeat(SLACK_TEXT_LIMIT) }))).success).toBe(true);
    fetchMock.mockClear();
    const r = await adapter().post(req({ content: "x".repeat(SLACK_TEXT_LIMIT + 1) }));
    expect(r.success).toBe(false);
    expect(classifyPostError("slack", r.errorMessage!).kind).toBe("fatal");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses empty text, images/videos and a connection with no channel, all before calling Slack, all as fatal", async () => {
    for (const over of [{ content: "  \n " }, { mediaUrl: "https://files.example.org/a.png" }, { mediaUrls: ["https://files.example.org/b.png"] }, { platformAccountId: null }, { platformAccountId: "T0001" }]) {
      const r = await adapter().post(req(over));
      expect(r.success).toBe(false);
      expect(classifyPostError("slack", r.errorMessage!).kind, JSON.stringify(over)).toBe("fatal");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Every Slack error code the brief names, and what the scheduler will do about it.
  const mappings: Array<[string, string, "retry" | "fatal" | "reconnect", RegExp?]> = [
    ["invalid_auth", "invalid_auth", "reconnect"],
    ["token_revoked", "token_revoked", "reconnect"],
    ["account_inactive", "account_inactive", "reconnect"],
    ["token_expired", "token_expired", "reconnect"],
    ["not_authed", "not_authed", "reconnect"],
    ["missing_scope", "missing_scope", "reconnect", /permissions/],
    ["channel_not_found", "channel_not_found", "fatal", /invite the LazyRelay app/],
    ["not_in_channel", "not_in_channel", "fatal", /invite the LazyRelay app/],
    ["is_archived", "is_archived", "fatal", /archived/],
    ["restricted_action", "restricted_action", "fatal", /workspace settings/],
    ["restricted_action_thread_only_channel", "restricted_action_thread_only_channel", "fatal", /workspace settings/],
    ["msg_too_long", "msg_too_long", "fatal", /4,000/],
    ["no_text", "no_text", "fatal", /4,000/],
    ["ratelimited", "ratelimited", "retry", /limiting requests/],
    ["internal_error", "internal_error", "retry"],
    ["service_unavailable", "service_unavailable", "retry"],
    ["request_timeout", "request_timeout", "retry"],
  ];
  it.each(mappings)("Slack error %s -> %s is classified correctly with a plain message", async (_n, code, kind, wording) => {
    fetchMock.mockResolvedValue(reply(200, { ok: false, error: code }));
    const r = await adapter().post(req());
    expect(r.success).toBe(false);
    expect(r.platformPostId).toBeNull();
    expect(r.errorMessage).toContain(code);
    const c = classifyPostError("slack", r.errorMessage!);
    expect(c.kind).toBe(kind);
    expect(c.message).toMatch(/Slack|channel|workspace|permissions/);
    if (wording) expect(c.message).toMatch(wording);
    expect(c.message).not.toContain(code); // customers see words, not codes
    expect(c.message).not.toMatch(/[–—]/);
  });

  it("maps HTTP 429 with Retry-After to a retryable rate limit and passes the wait along", async () => {
    fetchMock.mockResolvedValue(reply(429, "", { "retry-after": "42" }));
    const r = await adapter().post(req());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/ratelimited/);
    expect(r.errorMessage).toMatch(/42 seconds/);
    expect(classifyPostError("slack", r.errorMessage!).kind).toBe("retry");
  });

  it("ignores a silly Retry-After and never lets a header into the message verbatim", async () => {
    fetchMock.mockResolvedValue(reply(429, "", { "retry-after": "<script>99999999</script>" }));
    const r = await adapter().post(req());
    expect(r.errorMessage).toBe("Slack post failed: ratelimited");
    fetchMock.mockResolvedValue(reply(429, "", { "retry-after": "99999999" }));
    expect((await adapter().post(req())).errorMessage).toMatch(/3600 seconds/);
  });

  it("treats a gateway error or a network failure as temporary", async () => {
    fetchMock.mockResolvedValueOnce(reply(503, "<html>down</html>"));
    const a = await adapter().post(req());
    expect(classifyPostError("slack", a.errorMessage!).kind).toBe("retry");
    fetchMock.mockRejectedValueOnce(new Error(`ETIMEDOUT talking to slack with ${BOT_TOKEN}`));
    const b = await adapter().post(req());
    expect(classifyPostError("slack", b.errorMessage!).kind).toBe("retry");
    expect(b.errorMessage).not.toContain(BOT_TOKEN);
  });

  it("never echoes text from Slack's reply into a customer message (only a validated code gets through)", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: false, error: "channel_not_found <!channel> evil" }));
    const r = await adapter().post(req());
    expect(r.errorMessage).toBe("Slack post failed (HTTP 200)");
  });

  it("does not call a post live unless Slack returned a usable message id", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, channel: "C0123" }));
    const r = await adapter().post(req());
    expect(r.success).toBe(false);
    expect(r.platformPostId).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("proof of publish", () => {
  const PERMALINK = "https://acme.slack.com/archives/C0123/p1700000000000100";

  it("confirms with chat.getPermalink and uses the permalink as the proof link", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, channel: "C0123", permalink: PERMALINK }));
    const v = await adapter().verifyPublished("C0123:1700000000.000100", BOT_TOKEN);
    expect(v).toEqual({ verifiedLive: true, platformPostUrl: PERMALINK, errorMessage: null });
    const call = fetchMock.mock.calls[0];
    expect(initOf(call).method).toBe("GET");
    const u = urlOf(call);
    expect(u.origin + u.pathname).toBe("https://slack.com/api/chat.getPermalink");
    expect(u.searchParams.get("channel")).toBe("C0123");
    expect(u.searchParams.get("message_ts")).toBe("1700000000.000100");
    expect((initOf(call).headers as Record<string, string>).Authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(u.toString()).not.toContain(BOT_TOKEN);
  });

  it("never reads conversations.history or conversations.replies (they allow one request a minute for these apps)", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, permalink: PERMALINK }));
    await adapter().verifyPublished("C0123:1700000000.000100", BOT_TOKEN);
    fetchMock.mockResolvedValue(reply(200, { ok: false, error: "message_not_found" }));
    await adapter().verifyPublished("C0123:1700000000.000100", BOT_TOKEN);
    for (const call of fetchMock.mock.calls) expect(String(call[0])).not.toMatch(/conversations\.(history|replies)/);
  });

  it("does not confirm when Slack cannot find the message yet: unconfirmed, retryable, and the message says it will not be posted twice", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: false, error: "message_not_found" }));
    const v = await adapter().verifyPublished("C0123:1700000000.000100", BOT_TOKEN);
    expect(v.verifiedLive).toBe(false);
    expect(v.platformPostUrl).toBeNull();
    const c = classifyPostError("slack", v.errorMessage!);
    expect(c.kind).toBe("retry");
    expect(c.message).toMatch(/will not post it twice/);
  });

  it.each([
    ["ratelimited", "retry"],
    ["internal_error", "retry"],
    ["invalid_auth", "reconnect"],
    ["token_revoked", "reconnect"],
    ["channel_not_found", "fatal"],
  ] as const)("a permalink error %s is %s and never turns into a new post", async (code, kind) => {
    fetchMock.mockResolvedValue(reply(200, { ok: false, error: code }));
    const v = await adapter().verifyPublished("C0123:1700000000.000100", BOT_TOKEN);
    expect(v.verifiedLive).toBe(false);
    expect(classifyPostError("slack", v.errorMessage!).kind).toBe(kind);
    // verifyPublished only ever reads: it has no way to publish.
    for (const call of fetchMock.mock.calls) expect(String(call[0])).not.toContain("chat.postMessage");
  });

  it("a network failure while confirming is unconfirmed and retryable", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed"));
    const v = await adapter().verifyPublished("C0123:1700000000.000100", BOT_TOKEN);
    expect(v.verifiedLive).toBe(false);
    expect(classifyPostError("slack", v.errorMessage!).kind).toBe("retry");
  });

  it("only trusts a link that is https on Slack's own domain", async () => {
    for (const bad of ["http://acme.slack.com/archives/C0123/p1", "https://evil.example/archives/C0123/p1", "https://slack.com.evil.example/x", "javascript:alert(1)", "https://user:pw@acme.slack.com/x", "", "not a url"]) {
      fetchMock.mockResolvedValue(reply(200, { ok: true, permalink: bad }));
      const v = await adapter().verifyPublished("C0123:1700000000.000100", BOT_TOKEN);
      expect(v.verifiedLive, bad).toBe(false);
      expect(v.platformPostUrl, bad).toBeNull();
    }
    fetchMock.mockResolvedValue(reply(200, { ok: true, permalink: "https://acme.enterprise.slack.com/archives/C0123/p1" }));
    expect((await adapter().verifyPublished("C0123:1700000000.000100", BOT_TOKEN)).verifiedLive).toBe(true);
  });

  it("refuses a malformed post id without calling Slack", async () => {
    for (const bad of ["", "C0123", "C0123:abc", "c0123:1700000000.000100", "C0123:1700000000.000100:x"]) {
      const v = await adapter().verifyPublished(bad, BOT_TOKEN);
      expect(v.verifiedLive).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("token rotation (only when the Slack app has it on)", () => {
  it("renews with the refresh token and returns the rotated pair", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, access_token: "xoxe.xoxb-new", refresh_token: "xoxe-new-refresh", expires_in: 43200 }));
    const r = await adapter().refresh(REFRESH_TOKEN);
    expect(r).toMatchObject({ accessToken: "xoxe.xoxb-new", refreshToken: "xoxe-new-refresh" });
    expect(new Date(r.expiresAt!).getTime()).toBeGreaterThan(Date.now() + 11 * 3600_000);
    const form = sentForm(fetchMock.mock.calls[0]);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(REFRESH_TOKEN);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(urlOf(fetchMock.mock.calls[0]).search).toBe("");
  });

  it("a dead refresh token is recognised by the token job as a permanent grant failure", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: false, error: "invalid_refresh_token" }));
    const err = (await adapter().refresh(REFRESH_TOKEN).catch((e: Error) => e)) as Error;
    expect(isPermanentAuthError(err)).toBe(true);
    expect(err.message).not.toContain(REFRESH_TOKEN);
  });

  it("any other renewal failure is not treated as a dead grant (it is retried)", async () => {
    fetchMock.mockResolvedValue(reply(503, ""));
    const err = (await adapter().refresh(REFRESH_TOKEN).catch((e: Error) => e)) as Error;
    expect(isPermanentAuthError(err)).toBe(false);
    fetchMock.mockRejectedValue(new Error(`boom ${CLIENT_SECRET}`));
    const net = (await adapter().refresh(REFRESH_TOKEN).catch((e: Error) => e)) as Error;
    expect(isPermanentAuthError(net)).toBe(false);
    expect(net.message).not.toContain(CLIENT_SECRET);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("dormant by default", () => {
  const SLACK_ENV = ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_REDIRECT_URI"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of SLACK_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of SLACK_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is not in the platform registry unless all three Slack settings exist", async () => {
    const { buildPlatformRegistry } = await import("./registry.js");
    expect(buildPlatformRegistry().has("slack")).toBe(false);
    process.env.SLACK_CLIENT_ID = "id";
    process.env.SLACK_CLIENT_SECRET = "secret";
    expect(buildPlatformRegistry().has("slack")).toBe(false); // redirect still missing
    process.env.SLACK_REDIRECT_URI = REDIRECT;
    expect(buildPlatformRegistry().get("slack")).toBeInstanceOf(SlackAdapter);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("media", () => {
  it("refuses images and videos up front with a plain reason (text and links only in v1)", async () => {
    const { validateMediaForPlatform } = await import("../mediaLimits.js");
    const image = validateMediaForPlatform("slack", { mimeType: "image/png", sizeBytes: 1000, width: 100, height: 100 });
    expect(image.valid).toBe(false);
    expect(image.reason).toMatch(/does not accept image posts/);
    const video = validateMediaForPlatform("slack", { mimeType: "video/mp4", sizeBytes: 1000, width: null, height: null });
    expect(video.valid).toBe(false);
    expect(video.reason).toMatch(/does not accept video/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("secrets never reach the logs", () => {
  it("a whole connect, post and verify run, including failures, prints none of the token, secret, code or refresh token", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const secrets = [BOT_TOKEN, CLIENT_SECRET, CODE, REFRESH_TOKEN];

    fetchMock
      .mockResolvedValueOnce(reply(200, { ...INSTALL_OK, refresh_token: REFRESH_TOKEN, expires_in: 43200 }))
      .mockResolvedValueOnce(reply(200, { ok: true, channels: [channel("C0123", "general")], response_metadata: { next_cursor: "" } }))
      .mockResolvedValueOnce(reply(200, { ok: true, channels: [channel("C0123", "general")], response_metadata: { next_cursor: "" } }));
    const a = adapter();
    const held = await a.listConnectOptions(CODE);
    await a.finalizeConnectOption(held.userToken, "T0001:C0123");

    const messages: string[] = [];
    fetchMock.mockResolvedValueOnce(reply(200, { ok: true, channel: "C0123", ts: "1700000000.000100" }));
    await a.post(req());
    for (const code of ["invalid_auth", "ratelimited", "channel_not_found"]) {
      fetchMock.mockResolvedValueOnce(reply(200, { ok: false, error: code }));
      messages.push((await a.post(req())).errorMessage!);
    }
    fetchMock.mockRejectedValueOnce(new Error(`network trouble ${BOT_TOKEN}`));
    messages.push((await a.post(req())).errorMessage!);
    fetchMock.mockResolvedValueOnce(reply(200, { ok: false, error: "message_not_found" }));
    messages.push((await a.verifyPublished("C0123:1700000000.000100", BOT_TOKEN)).errorMessage!);
    fetchMock.mockResolvedValueOnce(reply(200, { ok: false, error: "invalid_refresh_token" }));
    messages.push(((await a.refresh(REFRESH_TOKEN).catch((e: Error) => e)) as Error).message);

    const printed = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secret of secrets) {
      expect(printed).not.toContain(secret);
      for (const m of messages) expect(m).not.toContain(secret);
    }
    // Not one request carries the bot token in its address.
    for (const call of fetchMock.mock.calls) {
      for (const secret of secrets) expect(String(call[0])).not.toContain(secret);
    }
  });
});
