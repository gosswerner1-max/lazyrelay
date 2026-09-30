import { isIP } from "node:net";
import { Agent, type Dispatcher } from "undici";
import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
  CommentsResult,
  CommentPostResult,
  PostMetrics,
} from "./types.js";
import { fetchMediaForStreaming, buildStreamingMultipartBody, type RequestInitWithDuplex } from "./streamUpload.js";
import { isSafeMediaUrl } from "../urlSafety.js";

// Lemmy is a federated link aggregator. Like Mastodon, every instance (lemmy.world,
// programming.dev, ...) is its own server, and the customer chooses theirs. There is no
// OAuth: the customer types instance + username + password (+ a 2FA code if they use one)
// on LazyRelay's own connect page, we log in once, and we keep only the JWT the instance
// returns. The password is never stored and never logged.
//
// Two API generations exist in the wild:
//   - /api/v3 (Lemmy 0.19.x). Every public instance checked on 2026-09-30 still runs this
//     (lemmy.world 0.19.19, lemmy.ml / sh.itjust.works / feddit.org 0.19.20, programming.dev
//     0.19.18) and answers 404 on /api/v4.
//   - /api/v4 (Lemmy 1.0). Shapes below come from the official lemmy-js-client `main`
//     branch. No live v4 instance was reachable, so the v4 branch is verified against the
//     client source only, not against a real server.
// We probe v3 first (the one verified live) and fall back to v4, and store the detected
// version next to the JWT so posting never has to guess.
//
// Auth: `Authorization: Bearer <jwt>` on both versions. Lemmy JWTs can live a long time
// (v4 login with stay_logged_in never expires, v3 tokens are long lived) but an instance
// admin, a password change or "log out everywhere" can invalidate one at any time. There is
// no refresh grant, so when a later call is refused we tell the customer to reconnect.
//
// Customer-supplied host, so every request re-runs the SSRF guard and is pinned to the exact
// addresses the guard validated (same approach as streamUpload.ts), never follows redirects
// (a redirect could carry the JWT to a different host), and has a 30 second timeout.

const REQUEST_TIMEOUT_MS = 30_000;
// A picture can take a while to upload to the instance's image host; everything else is small.
const UPLOAD_TIMEOUT_MS = 120_000;
// An instance is customer-controlled, so an API answer larger than this is refused unread.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// How far back to look for a post whose creation call timed out.
const RECOVERY_WINDOW_MS = 10 * 60_000;
const MAX_TITLE = 200;
// Lemmy's own body limit is much higher; 10000 keeps a scheduled post readable and is the
// limit agreed for LazyRelay's Lemmy adapter.
const MAX_BODY = 10_000;
const MAX_COMMENT = 10_000;

const AUTH_MESSAGE = "Lemmy refused the login. Reconnect this account.";
const BLOCKED_MESSAGE = "That Lemmy address is not allowed. It must be a public https address.";

type ApiVersion = 3 | 4;

interface LemmyCredentials {
  instance: string; // https origin, e.g. https://lemmy.world
  apiVersion: ApiVersion;
  jwt: string;
  username: string;
  community?: string;
}

/** A failure whose message is already safe and readable for the customer. */
class LemmyNetworkError extends Error {
  /** True when the request may have reached the instance before it failed (timeout, dropped
   *  connection). For a create call that means the post could exist even though we saw an error. */
  constructor(message: string, readonly possiblySent = false) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------
// Instance address handling
// ---------------------------------------------------------------------------------------

/** Accepts "lemmy.world" or "https://lemmy.world[/]" and returns "https://lemmy.world".
 *  Refuses anything that is not a bare https host: other schemes, paths, queries, logins
 *  in the address, or a port other than 443. Returns an error message otherwise. */
export function normalizeLemmyInstance(input: string): { ok: true; origin: string } | { ok: false; error: string } {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Enter your Lemmy instance, for example lemmy.world" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: "That does not look like a Lemmy instance address. Use something like lemmy.world" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "The Lemmy instance address must use https" };
  if (url.username || url.password) return { ok: false, error: "Do not put a username or password in the instance address" };
  if (url.port && url.port !== "443") return { ok: false, error: "The Lemmy instance address cannot use a custom port" };
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    return { ok: false, error: "Enter only the instance name, for example lemmy.world, without a path" };
  }
  const host = url.hostname.toLowerCase();
  if (!isIP(host) && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return { ok: false, error: "That does not look like a Lemmy instance address. Use something like lemmy.world" };
  }
  return { ok: true, origin: `https://${host}` };
}

/** Same pinning trick as streamUpload.ts (its helper is private): the connection can only
 *  go to the addresses isSafeMediaUrl just validated, so DNS cannot answer differently
 *  between the check and the request. */
function pinnedDispatcher(addresses: string[]): Dispatcher {
  const candidates = addresses
    .map((address) => ({ address, family: isIP(address) }))
    .filter((c): c is { address: string; family: 4 | 6 } => c.family === 4 || c.family === 6);
  return new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        if (candidates.length === 0) {
          callback(new Error("no valid pinned address"), "", 0);
          return;
        }
        if (options.all) callback(null, candidates);
        else callback(null, candidates[0].address, candidates[0].family);
      },
    },
  });
}

/** The one place a request to the customer's instance is made: guard, pin, no redirects,
 *  timeout. Throws LemmyNetworkError with a customer-safe message. */
async function lemmyFetch(url: string, init: RequestInitWithDuplex = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const parsed = new URL(url);
  const safety = await isSafeMediaUrl(parsed.origin);
  if (!safety.safe) throw new LemmyNetworkError(BLOCKED_MESSAGE);
  try {
    return await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: pinnedDispatcher(safety.addresses),
    } as RequestInitWithDuplex);
  } catch {
    // Deliberately no err.message: it can echo the URL or headers.
    throw new LemmyNetworkError(`Could not reach ${parsed.hostname}. Check the instance address and try again later.`, true);
  }
}

/** Reads a JSON body but stops (and returns null) once it passes MAX_RESPONSE_BYTES, so a
 *  hostile or broken instance cannot make us hold an unbounded answer in memory. */
async function readJsonCapped(res: Response): Promise<unknown> {
  if (!res.body) return null;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await res.body.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------------------

interface Api {
  origin: string;
  version: ApiVersion;
}

interface Reply {
  status: number;
  ok: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  retryAfter: string | null;
}

async function apiCall(
  api: Api,
  jwt: string | null,
  method: "GET" | "POST",
  path: string,
  opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<Reply> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) qs.set(k, String(v));
  const url = `${api.origin}/api/v${api.version}${path}${qs.toString() ? `?${qs.toString()}` : ""}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await lemmyFetch(url, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const json = await readJsonCapped(res);
  return { status: res.status, ok: res.status >= 200 && res.status < 300, json, retryAfter: res.headers.get("retry-after") };
}

/** Lemmy errors look like {"error":"incorrect_login"}. Only a plain snake_case code is
 *  ever passed on, so nothing surprising ends up in a customer-facing message. */
function errorCode(json: unknown): string | null {
  const e = (json as { error?: unknown } | null)?.error;
  return typeof e === "string" && /^[a-z0-9_]{1,80}$/i.test(e) ? e.toLowerCase() : null;
}

function rateLimitMessage(retryAfter: string | null): string {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  const hint = Number.isFinite(seconds) && seconds > 0 ? `in about ${Math.ceil(seconds)} seconds` : "in a few minutes";
  return `Lemmy is limiting how fast this account can act. Try again ${hint}.`;
}

const KNOWN_ERRORS: Record<string, string> = {
  site_ban: "This Lemmy account is banned on that instance.",
  banned_from_community: "This Lemmy account is banned from that community.",
  only_mods_can_post_in_community: "Only moderators can post in that Lemmy community.",
  couldnt_find_community: "Lemmy could not find that community.",
  couldnt_find_post: "Lemmy could not find that post.",
  couldnt_find_comment: "Lemmy could not find that comment.",
  language_not_allowed: "That community does not allow the post's language.",
  invalid_url: "Lemmy did not accept the link for this post.",
  blocked_url: "That instance blocks the link used in this post.",
  locked: "That post or community is locked.",
  post_title_too_long: "The Lemmy post title is too long.",
  registration_application_pending: "This account is still waiting for approval by the instance admins.",
};

const AUTH_CODE = /not_logged_in|expired|invalid_token|jwt|unauthor/;

/** Turns a failed reply into one plain sentence. Never includes the JWT or the request body. */
function explain(reply: Reply, doing: string): string {
  if (reply.status === 429) return rateLimitMessage(reply.retryAfter);
  const code = errorCode(reply.json);
  if (reply.status === 401 || (code && AUTH_CODE.test(code))) return AUTH_MESSAGE;
  if (code === "rate_limit_error") return rateLimitMessage(reply.retryAfter);
  if (code && KNOWN_ERRORS[code]) return KNOWN_ERRORS[code];
  if (reply.status >= 300 && reply.status < 400) {
    return "That Lemmy instance redirected the request. Reconnect using the instance's main address.";
  }
  if (code) return `Lemmy could not ${doing} (${code}).`;
  return `Lemmy could not ${doing} (HTTP ${reply.status}).`;
}

/** Works out which API generation an instance speaks. v3 first: it is the one verified
 *  against live servers; v4 is only tried when v3 does not answer. */
async function detectApi(origin: string): Promise<Api> {
  for (const version of [3, 4] as const) {
    const reply = await apiCall({ origin, version }, null, "GET", "/site");
    // A busy or broken v3 server is not proof the instance lacks v3: say what happened
    // instead of moving on to v4 and calling it "not Lemmy".
    if (version === 3 && (reply.status === 429 || reply.status >= 500)) {
      throw new LemmyNetworkError(
        reply.status === 429 ? rateLimitMessage(reply.retryAfter) : `That Lemmy instance had a server problem (HTTP ${reply.status}). Try again later.`,
      );
    }
    if (reply.ok && reply.json && typeof reply.json === "object" && reply.json.site_view && typeof reply.json.version === "string") {
      return { origin, version };
    }
  }
  throw new LemmyNetworkError(
    "That address did not answer like a Lemmy instance. Check the instance name, for example lemmy.world.",
  );
}

function parseCredentials(accessToken: string): LemmyCredentials {
  let parsed: Partial<LemmyCredentials>;
  try {
    parsed = JSON.parse(accessToken) as Partial<LemmyCredentials>;
  } catch {
    throw new LemmyNetworkError("The saved Lemmy connection is damaged. Reconnect this account.");
  }
  const norm = typeof parsed.instance === "string" ? normalizeLemmyInstance(parsed.instance) : null;
  if (!norm || !norm.ok || (parsed.apiVersion !== 3 && parsed.apiVersion !== 4) || typeof parsed.jwt !== "string" || !parsed.jwt) {
    throw new LemmyNetworkError("The saved Lemmy connection is damaged. Reconnect this account.");
  }
  return { instance: norm.origin, apiVersion: parsed.apiVersion, jwt: parsed.jwt, username: parsed.username ?? "", community: parsed.community };
}

const apiOf = (c: LemmyCredentials): Api => ({ origin: c.instance, version: c.apiVersion });

function cleanCommunity(input: string): string | null {
  const c = input.trim().replace(/^!/, "");
  return /^[A-Za-z0-9_]{1,200}(@[A-Za-z0-9.-]+)?$/.test(c) ? c : null;
}

/** community name (name or name@instance) -> numeric community_id. */
async function resolveCommunity(api: Api, jwt: string, name: string): Promise<{ id: number } | { error: string }> {
  const reply = await apiCall(api, jwt, "GET", "/community", { query: { name } });
  const id = reply.json?.community_view?.community?.id;
  if (!reply.ok || typeof id !== "number") {
    if (reply.status === 404 || errorCode(reply.json) === "couldnt_find_community") {
      return { error: `Lemmy could not find the community "${name}". Check the name, for example programming@programming.dev.` };
    }
    return { error: explain(reply, "look up that community") };
  }
  const community = reply.json.community_view.community;
  if (community.removed || community.deleted) return { error: `The Lemmy community "${name}" has been removed.` };
  return { id };
}

// ---------------------------------------------------------------------------------------
// Post text
// ---------------------------------------------------------------------------------------

const VIDEO_URL = /\.(mp4|mov|m4v|webm|mkv|avi)(\?.*)?$/i;

/** Title = options.title, else the first non-empty line with markdown "#" removed. When the
 *  first line is used as the title the rest becomes the body; a first line longer than the
 *  title limit is cut and the full text stays in the body so nothing is lost. */
export function deriveLemmyText(content: string, optionTitle: string | undefined): { title: string; body: string } | { error: string } {
  const text = content.trim();
  if (optionTitle && optionTitle.trim()) {
    return { title: optionTitle.trim().slice(0, MAX_TITLE), body: text };
  }
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\s#+\s*$/, "").trim() !== "");
  if (idx === -1) return { error: "Lemmy needs a title. Write some text or set options.lemmy.title." };
  const first = lines[idx].replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\s#+\s*$/, "").trim();
  if (first.length > MAX_TITLE) {
    const cut = first.slice(0, MAX_TITLE - 3);
    const space = cut.lastIndexOf(" ");
    return { title: `${(space > 100 ? cut.slice(0, space) : cut).trimEnd()}...`, body: text };
  }
  return { title: first, body: lines.slice(idx + 1).join("\n").trim() };
}

const escapeAlt = (alt: string) => alt.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
const IMAGE_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" };

// ---------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------

export class LemmyAdapter implements PlatformAdapter {
  readonly platform: "lemmy" = "lemmy";
  // The customer types the account on LazyRelay's own connect page, so there is nothing to
  // confirm afterwards (see connect.ts).
  readonly skipConnectConfirmation = true;

  constructor(private readonly connectPageUrl: string) {}

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({ state });
    return `${this.connectPageUrl}?${params.toString()}`;
  }

  // `code` is JSON: {"instance","username","password","totpToken"?,"community"?}.
  // Customers should tick "Bot account" in their Lemmy profile settings: instances and
  // communities treat automated posts from a non-bot account as breaking their rules. We
  // read the flag (my_user.local_user_view.person.bot_account) but still connect without it,
  // because no instance rejects posting over it; the integrator shows the reminder.
  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    let form: { instance?: string; username?: string; password?: string; totpToken?: string; community?: string };
    try {
      form = JSON.parse(code) as typeof form;
    } catch {
      throw new Error("Lemmy connect needs an instance, a username and a password");
    }
    if (!form || typeof form.instance !== "string" || typeof form.username !== "string" || typeof form.password !== "string" || !form.username.trim() || !form.password) {
      throw new Error("Lemmy connect needs an instance, a username and a password");
    }
    const norm = normalizeLemmyInstance(form.instance);
    if (!norm.ok) throw new Error(norm.error);

    let defaultCommunity: string | undefined;
    if (typeof form.community === "string" && form.community.trim()) {
      const c = cleanCommunity(form.community);
      if (!c) throw new Error("The default community must look like name or name@instance.example");
      defaultCommunity = c;
    }

    try {
      // Nothing is sent to the instance until lemmyFetch has run the SSRF guard on it.
      const api = await detectApi(norm.origin);

      const loginBody: Record<string, unknown> = { username_or_email: form.username.trim(), password: form.password };
      if (typeof form.totpToken === "string" && form.totpToken.trim()) loginBody.totp_2fa_token = form.totpToken.trim();
      if (api.version === 4) loginBody.stay_logged_in = true; // v4: without it the token expires after a week
      const login = await apiCall(api, null, "POST", api.version === 4 ? "/account/auth/login" : "/user/login", { body: loginBody });

      if (!login.ok || typeof login.json?.jwt !== "string") {
        throw new Error(explainLogin(login));
      }
      const jwt: string = login.json.jwt;

      // Confirm the account is really usable with this token before saving anything.
      const site = await apiCall(api, jwt, "GET", "/site");
      const person = site.json?.my_user?.local_user_view?.person as { name?: string; deleted?: boolean } | undefined;
      if (!site.ok || !person?.name) {
        throw new Error("Lemmy accepted the login but did not confirm the account. Try connecting again.");
      }
      if (person.deleted) throw new Error("That Lemmy account has been deleted.");

      if (defaultCommunity) {
        const found = await resolveCommunity(api, jwt, defaultCommunity);
        if ("error" in found) throw new Error(found.error);
      }

      const host = new URL(api.origin).hostname;
      const credentials: LemmyCredentials = {
        instance: api.origin,
        apiVersion: api.version,
        jwt,
        username: person.name,
        ...(defaultCommunity ? { community: defaultCommunity } : {}),
      };
      return {
        accessToken: JSON.stringify(credentials),
        refreshToken: null,
        expiresAt: null,
        platformAccountId: `${person.name}@${host}`,
        displayName: `@${person.name}@${host}`,
      };
    } catch (err) {
      // Every throw above already carries a readable message with no secrets in it.
      if (err instanceof Error) throw err;
      throw new Error("Could not connect to Lemmy");
    }
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const fail = (errorMessage: string): PostAttemptResult => ({ success: false, platformPostId: null, errorMessage });
    try {
      const creds = parseCredentials(request.accessToken);
      const api = apiOf(creds);
      const options = request.options?.lemmy;

      const communityName = options?.community ? cleanCommunity(options.community) : creds.community ?? null;
      if (!communityName) {
        return fail("Choose a Lemmy community for this post (options.lemmy.community, for example programming@programming.dev)");
      }

      const text = deriveLemmyText(request.content ?? "", options?.title);
      if ("error" in text) return fail(text.error);

      // Video: pict-rs is an image host and Lemmy has no video upload, so refuse clearly.
      const images = [request.mediaUrl, ...(request.mediaUrls ?? [])].filter((u): u is string => !!u);
      if (images.some((u) => VIDEO_URL.test(u))) {
        return fail("Lemmy does not support video uploads. Post an image, or put a link to the video in options.lemmy.url.");
      }

      const community = await resolveCommunity(api, creds.jwt, communityName);
      if ("error" in community) return fail(community.error);

      // Upload before creating the post: any failed upload stops here, so a post is never
      // created with a missing picture.
      const uploaded: string[] = [];
      for (const mediaUrl of images) {
        const result = await this.uploadImage(api, creds.jwt, mediaUrl);
        if ("error" in result) return fail(result.error);
        uploaded.push(result.url);
      }

      let postUrl: string | undefined = options?.url;
      const alt = request.mediaAltText ? escapeAlt(request.mediaAltText) : "";
      let body = text.body;
      const markdownImages: string[] = [];
      uploaded.forEach((url, i) => {
        if (i === 0 && !postUrl) {
          postUrl = url; // first image is the link post, so Lemmy shows it as the picture
        } else {
          markdownImages.push(`![${i === 0 ? alt : ""}](${url})`);
        }
      });
      if (markdownImages.length > 0) body = [body, markdownImages.join("\n\n")].filter(Boolean).join("\n\n");

      if (body.length > MAX_BODY) {
        return fail(`The post text is ${body.length} characters. Lemmy posts through LazyRelay can be up to ${MAX_BODY} characters.`);
      }

      const payload: Record<string, unknown> = {
        name: text.title,
        community_id: community.id,
        ...(postUrl ? { url: postUrl } : {}),
        ...(body ? { body } : {}),
        ...(postUrl && postUrl === uploaded[0] && alt ? { alt_text: alt.slice(0, 1000) } : {}),
        ...(options?.nsfw !== undefined ? { nsfw: options.nsfw } : {}),
        // honeypot is a bot trap: it must stay empty, so it is not sent at all.
      };
      // A timeout or dropped connection here does not mean nothing was created: Lemmy may
      // have saved the post before the answer got lost, and a blind retry would duplicate
      // it. So when the outcome is unknown, look for the post before reporting anything.
      let created: Reply | null = null;
      try {
        created = await apiCall(api, creds.jwt, "POST", "/post", { body: payload });
      } catch (err) {
        if (!(err instanceof LemmyNetworkError) || !err.possiblySent) throw err;
      }
      const id = created?.json?.post_view?.post?.id;
      if (created && created.ok && typeof id === "number") return { success: true, platformPostId: String(id), errorMessage: null };
      if (created && created.status < 500 && !created.ok) return fail(explain(created, "publish the post"));
      // Unknown outcome: no answer, a server error, or a success we could not read.
      const found = await this.findRecentPost(api, creds, community.id, text.title);
      if (found) return { success: true, platformPostId: found, errorMessage: null };
      return fail(
        "Lemmy did not confirm whether the post was published. Check the community on Lemmy before trying again, so it is not posted twice.",
      );
    } catch (err) {
      return fail(err instanceof LemmyNetworkError ? err.message : "Lemmy post failed unexpectedly");
    }
  }

  /** After an unconfirmed create: this account's newest posts in the community, looking for
   *  the same title made in the last few minutes. Returns the post id, or null if not found
   *  (or if the lookup itself fails, which stays "unconfirmed"). */
  private async findRecentPost(api: Api, creds: LemmyCredentials, communityId: number, title: string): Promise<string | null> {
    try {
      const list = await apiCall(api, creds.jwt, "GET", "/post/list", {
        query: { community_id: communityId, sort: "New", limit: 20, type_: "All" },
      });
      if (!list.ok || !Array.isArray(list.json?.posts)) return null;
      const since = Date.now() - RECOVERY_WINDOW_MS;
      for (const view of list.json.posts as Array<Record<string, any>>) { // eslint-disable-line @typescript-eslint/no-explicit-any
        const post = view.post;
        if (!post || typeof post.id !== "number" || post.name !== title || post.removed || post.deleted) continue;
        if (view.creator?.name !== creds.username) continue;
        const made = Date.parse(post.published ?? post.published_at ?? "");
        if (Number.isFinite(made) && made >= since) return String(post.id);
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Streams an image from LazyRelay storage to the instance's own image host. */
  private async uploadImage(api: Api, jwt: string, mediaUrl: string): Promise<{ url: string } | { error: string }> {
    const media = await fetchMediaForStreaming(mediaUrl);
    if (!media) return { error: `Could not fetch the image from ${mediaUrl}` };
    const type = media.contentType.split(";")[0].trim().toLowerCase();
    if (type.startsWith("video/")) {
      await media.body.cancel().catch(() => undefined);
      return { error: "Lemmy does not support video uploads. Post an image, or put a link to the video in options.lemmy.url." };
    }
    if (!type.startsWith("image/") && type !== "application/octet-stream") {
      await media.body.cancel().catch(() => undefined);
      return { error: "Lemmy can only upload images." };
    }

    const { body, contentType, contentLength } = buildStreamingMultipartBody([
      { fieldName: "images[]", value: { filename: `image.${IMAGE_EXT[type] ?? "jpg"}`, contentType: type, data: media.body, sizeBytes: media.sizeBytes } },
    ]);
    // v3: the instance proxies pict-rs at /pictrs/image (form field images[], answer
    // {msg:"ok", files:[{file, delete_token}]}). v4: POST /api/v4/image answers
    // {image_url, filename}. The JWT goes as a Bearer header and, for the pict-rs proxy,
    // as the jwt cookie lemmy-ui itself uses; both only ever go to the instance host.
    const url = api.version === 4 ? `${api.origin}/api/v4/image` : `${api.origin}/pictrs/image`;
    const res = await lemmyFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Cookie: `jwt=${jwt}`,
        "Content-Type": contentType,
        ...(contentLength != null ? { "Content-Length": String(contentLength) } : {}),
      },
      body,
      duplex: "half",
    }, UPLOAD_TIMEOUT_MS);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (await readJsonCapped(res)) as any;
    const reply: Reply = { status: res.status, ok: res.status >= 200 && res.status < 300, json, retryAfter: res.headers.get("retry-after") };
    if (res.status === 413) return { error: "Lemmy rejected the image because it is too large." };
    if (!reply.ok) return { error: explain(reply, "upload the image") };

    if (api.version === 4) {
      const imageUrl = json?.image_url;
      if (typeof imageUrl !== "string" || !imageUrl.startsWith("https://")) return { error: "Lemmy did not return a link for the uploaded image." };
      return { url: imageUrl };
    }
    const file = json?.msg === "ok" ? json?.files?.[0]?.file : null;
    if (typeof file !== "string" || !file) return { error: "Lemmy did not accept the uploaded image." };
    return { url: `${api.origin}/pictrs/image/${encodeURIComponent(file)}` };
  }

  // Proof of Publish: read the post back from the instance as the account, refuse a removed
  // or deleted one, repeat the read with NO login (what a stranger gets), then also require
  // the public page to answer HTTP 200. The page alone proves little: lemmy-ui is a
  // single-page app that can answer 200 for any /post/N.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const notLive = (errorMessage: string): VerifyResult => ({ verifiedLive: false, platformPostUrl: null, errorMessage });
    try {
      const creds = parseCredentials(accessToken);
      if (!/^\d+$/.test(platformPostId)) return notLive("That is not a Lemmy post id.");
      const reply = await apiCall(apiOf(creds), creds.jwt, "GET", "/post", { query: { id: platformPostId } });
      const post = reply.json?.post_view?.post as { id?: number; removed?: boolean; deleted?: boolean; ap_id?: string } | undefined;
      if (!reply.ok || !post || String(post.id) !== platformPostId) {
        return notLive(explain(reply, "confirm the post"));
      }
      if (post.removed) return notLive("A moderator removed this post from Lemmy.");
      if (post.deleted) return notLive("This post was deleted on Lemmy.");

      // What the account sees is not what a stranger sees (removed, hidden or restricted
      // posts can still show for the author), so read it again with NO login.
      const publicRead = await apiCall(apiOf(creds), null, "GET", "/post", { query: { id: platformPostId } });
      if (publicRead.status === 401 || publicRead.status === 403 || publicRead.status === 404 || errorCode(publicRead.json) === "couldnt_find_post") {
        return notLive("The post exists for the account but Lemmy does not show it publicly, so it cannot be confirmed as visible.");
      }
      const publicView = publicRead.json?.post_view as { post?: { id?: number; removed?: boolean; deleted?: boolean }; community?: { removed?: boolean; deleted?: boolean } } | undefined;
      if (!publicRead.ok || !publicView?.post || String(publicView.post.id) !== platformPostId) {
        return notLive(explain(publicRead, "read the post publicly"));
      }
      if (publicView.post.removed) return notLive("A moderator removed this post from Lemmy.");
      if (publicView.post.deleted) return notLive("This post was deleted on Lemmy.");
      const publicCommunity = publicRead.json?.community_view?.community ?? publicView.community;
      if (publicCommunity?.removed || publicCommunity?.deleted) return notLive("The community this post is in has been removed from Lemmy.");

      // Always test the instance's own page, never a host that came back in the data.
      const publicUrl = `${creds.instance}/post/${platformPostId}`;
      const page = await lemmyFetch(publicUrl, { method: "GET", headers: { Accept: "text/html", "User-Agent": "LazyRelay/1.0 (+https://lazyrelay.com)" } });
      await page.body?.cancel().catch(() => undefined);
      if (page.status !== 200) {
        return notLive(`The post exists on Lemmy but its public page answered HTTP ${page.status}, so it cannot be confirmed as visible.`);
      }
      const apId = typeof post.ap_id === "string" && post.ap_id.startsWith(`${creds.instance}/`) ? post.ap_id : publicUrl;
      return { verifiedLive: true, platformPostUrl: apId, errorMessage: null };
    } catch (err) {
      return notLive(err instanceof LemmyNetworkError ? err.message : "Lemmy post could not be confirmed");
    }
  }

  async getComments(platformPostId: string, accessToken: string): Promise<CommentsResult> {
    try {
      const creds = parseCredentials(accessToken);
      if (!/^\d+$/.test(platformPostId)) return { comments: [], errorMessage: "That is not a Lemmy post id." };
      const reply = await apiCall(apiOf(creds), creds.jwt, "GET", "/comment/list", {
        query: { post_id: platformPostId, sort: "New", limit: 50, max_depth: 8 },
      });
      if (!reply.ok || !Array.isArray(reply.json?.comments)) return { comments: [], errorMessage: explain(reply, "load comments") };

      const comments = (reply.json.comments as Array<Record<string, any>>).flatMap((view) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const c = view.comment;
        if (!c || typeof c.id !== "number" || c.removed || c.deleted) return [];
        return [
          {
            id: String(c.id),
            author: view.creator?.display_name || view.creator?.name || "Unknown",
            text: typeof c.content === "string" ? c.content : "",
            url: typeof c.ap_id === "string" ? c.ap_id : null,
            createdAt: c.published ?? c.published_at ?? null,
          },
        ];
      });
      return { comments, errorMessage: null };
    } catch (err) {
      return { comments: [], errorMessage: err instanceof LemmyNetworkError ? err.message : "Could not load Lemmy comments" };
    }
  }

  // A top-level comment on our own post.
  async postComment(platformPostId: string, text: string, accessToken: string): Promise<CommentPostResult> {
    return this.createComment(text, accessToken, { postId: platformPostId });
  }

  // A reply needs the comment's post id, which Lemmy wants in the same request, so it is
  // looked up from the comment first.
  async replyToComment(commentId: string, text: string, accessToken: string): Promise<CommentPostResult> {
    return this.createComment(text, accessToken, { parentId: commentId });
  }

  private async createComment(text: string, accessToken: string, target: { postId?: string; parentId?: string }): Promise<CommentPostResult> {
    try {
      const creds = parseCredentials(accessToken);
      const api = apiOf(creds);
      if (!text.trim()) return { success: false, errorMessage: "A Lemmy comment cannot be empty." };
      if (text.length > MAX_COMMENT) return { success: false, errorMessage: `A Lemmy comment can be up to ${MAX_COMMENT} characters.` };
      let postId = target.postId;
      if (target.parentId) {
        if (!/^\d+$/.test(target.parentId)) return { success: false, errorMessage: "That is not a Lemmy comment id." };
        const found = await apiCall(api, creds.jwt, "GET", "/comment", { query: { id: target.parentId } });
        const pid = found.json?.comment_view?.comment?.post_id;
        if (!found.ok || typeof pid !== "number") return { success: false, errorMessage: explain(found, "find that comment") };
        postId = String(pid);
      }
      if (!postId || !/^\d+$/.test(postId)) return { success: false, errorMessage: "That is not a Lemmy post id." };
      const res = await apiCall(api, creds.jwt, "POST", "/comment", {
        body: { content: text, post_id: Number(postId), ...(target.parentId ? { parent_id: Number(target.parentId) } : {}) },
      });
      if (!res.ok || typeof res.json?.comment_view?.comment?.id !== "number") return { success: false, errorMessage: explain(res, "post the comment") };
      return { success: true, errorMessage: null };
    } catch (err) {
      return { success: false, errorMessage: err instanceof LemmyNetworkError ? err.message : "Lemmy comment failed unexpectedly" };
    }
  }

  // v3 keeps the numbers in post_view.counts, v4 moves them onto post_view.post. Anything
  // missing stays null: "unknown" is never reported as zero. Lemmy shows no view counts.
  async getPostMetrics(platformPostId: string, accessToken: string): Promise<PostMetrics> {
    const empty = (errorMessage: string): PostMetrics => ({ likes: null, comments: null, shares: null, views: null, errorMessage });
    try {
      const creds = parseCredentials(accessToken);
      if (!/^\d+$/.test(platformPostId)) return empty("That is not a Lemmy post id.");
      const reply = await apiCall(apiOf(creds), creds.jwt, "GET", "/post", { query: { id: platformPostId } });
      const view = reply.json?.post_view;
      if (!reply.ok || !view?.post) return empty(explain(reply, "load metrics"));
      const src = (view.counts ?? view.post) as { upvotes?: unknown; score?: unknown; comments?: unknown };
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      return { likes: num(src.upvotes) ?? num(src.score), comments: num(src.comments), shares: null, views: null, errorMessage: null };
    } catch (err) {
      return empty(err instanceof LemmyNetworkError ? err.message : "Could not load Lemmy metrics");
    }
  }
}

/** Login failures, in plain language. Codes are Lemmy's own error names. */
function explainLogin(reply: Reply): string {
  if (reply.status === 429) return rateLimitMessage(reply.retryAfter);
  const code = errorCode(reply.json);
  if (reply.ok) {
    if (reply.json?.registration_created) return "This Lemmy account is waiting for approval by the instance admins. Connect again once it is approved.";
    if (reply.json?.verify_email_sent) return "Verify your email address on Lemmy first (check your inbox), then connect again.";
    return "Lemmy did not return a login. Check the username and password.";
  }
  if (code === "incorrect_login") return "Lemmy says the username or password is wrong.";
  if (code === "missing_totp_token") return "This Lemmy account uses two factor login. Enter the current code from your authenticator app.";
  if (code && /totp/.test(code)) return "That two factor code was wrong or has expired. Enter the newest code and try again.";
  if (code === "email_not_verified") return "Verify your email address on Lemmy first, then connect again.";
  if (code === "registration_application_pending" || code === "registration_application_is_pending") {
    return "This Lemmy account is waiting for approval by the instance admins. Connect again once it is approved.";
  }
  if (code === "registration_denied") return "The instance admins declined this Lemmy account.";
  if (code === "site_ban") return "This Lemmy account is banned on that instance.";
  if (code === "rate_limit_error") return rateLimitMessage(reply.retryAfter);
  if (reply.status >= 300 && reply.status < 400) return "That Lemmy instance redirected the login. Use the instance's main address.";
  if (code) return `Lemmy could not log in (${code}).`;
  return `Lemmy could not log in (HTTP ${reply.status}).`;
}
