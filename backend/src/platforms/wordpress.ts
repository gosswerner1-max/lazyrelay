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
} from "./types.js";
import { fetchMediaForStreaming, type RequestInitWithDuplex } from "./streamUpload.js";
import { isSafeMediaUrl } from "../urlSafety.js";

// Self-hosted WordPress through the core REST API, logged in with an
// Application Password (built into WordPress core since 5.6, no plugin).
// Like Discord's webhook, the customer pastes credentials on LazyRelay's own
// connect page: site address, WordPress username, and an application password
// they create under Users -> Profile -> Application Passwords. The three
// values are stored as JSON in accessToken (vault-encrypted by the caller).
//
// Every request goes to a server the customer controls, so every call is
// SSRF-guarded (urlSafety.ts) at connect time AND at post time (DNS can
// change in between), pinned to the address the guard validated, and never
// follows redirects: the Basic auth header must never leave the customer's
// own host. A 3xx is reported as an error asking for the final address.

const REQUEST_TIMEOUT_MS = 30_000;
// Media uploads stream a whole file, so they get a longer window.
const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_TITLE_LENGTH = 250;
const MAX_PUBLIC_REDIRECTS = 4;
// Bodies come from a server the customer controls: cap what we will read.
const MAX_API_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PUBLIC_PAGE_BYTES = 256 * 1024;
const MAX_SERVER_MESSAGE_CHARS = 300;

const MSG_LOGIN_REFUSED = "WordPress refused the login. The application password may have been revoked. Reconnect this account.";
const MSG_NO_PERMISSION =
  "WordPress refused this action. The connected user may not be allowed to publish posts (it needs the Author role or higher). Check the user's role or reconnect this account.";
const MSG_CORRUPT = "The saved WordPress connection could not be read. Reconnect this account.";

interface WordPressCredentials {
  siteUrl: string;
  username: string;
  applicationPassword: string;
  /** Only set when the site has no pretty permalinks, so /wp-json is not
   *  reachable and the ?rest_route= form has to be used for every call. */
  useRestRoute?: boolean;
}

function parseCredentials(accessToken: string): WordPressCredentials | null {
  try {
    const parsed = JSON.parse(accessToken) as Partial<WordPressCredentials>;
    if (
      typeof parsed.siteUrl !== "string" ||
      typeof parsed.username !== "string" ||
      typeof parsed.applicationPassword !== "string" ||
      !parsed.siteUrl ||
      !parsed.username ||
      !parsed.applicationPassword
    ) {
      return null;
    }
    return {
      siteUrl: parsed.siteUrl,
      username: parsed.username,
      applicationPassword: parsed.applicationPassword,
      ...(parsed.useRestRoute ? { useRestRoute: true } : {}),
    };
  } catch {
    return null;
  }
}

/** Origin plus any subdirectory (https://example.com/blog), no trailing slash.
 *  Returns an error string in plain language instead when unusable. */
export function normalizeSiteUrl(input: string): { ok: true; siteUrl: string } | { ok: false; error: string } {
  let raw = input.trim();
  if (!raw) return { ok: false, error: "Enter your WordPress site address, for example https://example.com" };
  // A bare "example.com" is an easy slip; assume https rather than fail.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "That does not look like a valid site address. Use something like https://example.com" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "The site address must start with https:// (WordPress logins are not sent over plain http)." };
  }
  // Only the default https port: a custom port would let a customer aim the
  // server at arbitrary services on a public host.
  if (parsed.port !== "") {
    return { ok: false, error: "The site address must use the standard https port (443). Remove the port number from the address." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "Do not put a username or password in the site address. Enter them in their own fields." };
  }
  // Customers often paste the admin or API address; the site root is what we need.
  let path = parsed.pathname.replace(/\/(wp-json|wp-admin|wp-login\.php)(\/.*)?$/i, "").replace(/\/+$/, "");
  if (path === "/") path = "";
  return { ok: true, siteUrl: `https://${parsed.host}${path}` };
}

// Same idea as streamUpload.ts's pinnedDispatcher (not exported there): make
// the actual TCP connection use the address the guard already validated,
// instead of resolving the hostname a second time.
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

type Json = Record<string, unknown>;

interface ApiCall {
  method?: "GET" | "POST";
  route: string; // e.g. /wp/v2/posts
  query?: Record<string, string>;
  json?: unknown;
  raw?: { body: ReadableStream<Uint8Array>; headers: Record<string, string> };
  timeoutMs?: number;
}

interface ApiResponse {
  status: number;
  /** Parsed JSON, or null when the body was not JSON (an HTML error page, say). */
  body: unknown;
  location: string | null;
  /** The body could not be read (network drop mid-body, or over the size cap). */
  unreadable: boolean;
}

/** Reads a response body as text with a hard byte cap. "throw" aborts an
 *  oversized body; "truncate" keeps the first maxBytes (for public pages). */
async function readBodyText(res: Response, maxBytes: number, overflow: "throw" | "truncate"): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    if (text.length <= maxBytes) return text;
    if (overflow === "throw") throw new Error("response too large");
    return text.slice(0, maxBytes);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      if (overflow === "throw") throw new Error("response too large");
      chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Server-supplied error text is shown to the customer, so it is capped and
 *  scrubbed: no markup, no copy of the password, no long token-like strings. */
function scrubServerMessage(message: string, secret: string): string {
  let out = message.replace(/<[^>]*>/g, " ");
  for (const variant of new Set([secret, secret.replace(/\s+/g, "")])) {
    if (variant.length >= 4) out = out.split(variant).join("[removed]");
  }
  out = out.replace(/[A-Za-z0-9+/=_-]{24,}/g, "[removed]").replace(/\s+/g, " ").trim();
  return out.length > MAX_SERVER_MESSAGE_CHARS ? `${out.slice(0, MAX_SERVER_MESSAGE_CHARS)}...` : out;
}

function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function errorCode(body: unknown): string {
  const code = asObject(body).code;
  return typeof code === "string" ? code : "";
}

function errorText(body: unknown): string {
  const message = asObject(body).message;
  return typeof message === "string" ? message : "";
}

/** One guarded, address-pinned connection to a customer's site. The Basic auth
 *  header is only ever attached to requests built from this site's own URL. */
class SiteSession {
  useRestRoute: boolean;
  private readonly authHeader: string;

  private constructor(
    private readonly creds: WordPressCredentials,
    private readonly dispatcher: Dispatcher,
  ) {
    this.useRestRoute = creds.useRestRoute === true;
    this.authHeader = `Basic ${Buffer.from(`${creds.username}:${creds.applicationPassword}`, "utf8").toString("base64")}`;
  }

  static async open(creds: WordPressCredentials): Promise<{ ok: true; session: SiteSession } | { ok: false; error: string }> {
    let customPort = false;
    try {
      customPort = new URL(creds.siteUrl).port !== "";
    } catch {
      customPort = true;
    }
    if (customPort) return { ok: false, error: "The site address must use the standard https port (443)." };
    const safety = await isSafeMediaUrl(creds.siteUrl);
    if (!safety.safe) {
      return {
        ok: false,
        error: `LazyRelay cannot connect to that address (${safety.reason}). Use your public https site address.`,
      };
    }
    return { ok: true, session: new SiteSession(creds, pinnedDispatcher(safety.addresses)) };
  }

  close(): void {
    void this.dispatcher.close().catch(() => undefined);
  }

  get siteUrl(): string {
    return this.creds.siteUrl;
  }

  private buildUrl(route: string, query?: Record<string, string>): string {
    const params = new URLSearchParams(query ?? {});
    if (this.useRestRoute) {
      // ?rest_route= is WordPress's own fallback for sites without pretty permalinks.
      const extra = params.toString();
      return `${this.creds.siteUrl}/?rest_route=${route}${extra ? `&${extra}` : ""}`;
    }
    const extra = params.toString();
    return `${this.creds.siteUrl}/wp-json${route}${extra ? `?${extra}` : ""}`;
  }

  async request(call: ApiCall): Promise<ApiResponse> {
    const headers: Record<string, string> = { Authorization: this.authHeader, Accept: "application/json" };
    let body: BodyInit | undefined;
    if (call.raw) {
      Object.assign(headers, call.raw.headers);
      body = call.raw.body as unknown as BodyInit;
    } else if (call.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(call.json);
    }
    let res: Response;
    try {
      res = await fetch(this.buildUrl(call.route, call.query), {
        method: call.method ?? "GET",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(call.timeoutMs ?? REQUEST_TIMEOUT_MS),
        dispatcher: this.dispatcher,
        ...(call.raw ? { duplex: "half" as const } : {}),
      } as RequestInitWithDuplex);
    } catch {
      throw new Error("Could not reach your WordPress site. Check that it is online and that the address is right, then try again.");
    }
    const location = res.headers?.get?.("location") ?? null;
    let parsed: unknown = null;
    let unreadable = false;
    try {
      parsed = JSON.parse(await readBodyText(res, MAX_API_BODY_BYTES, "throw"));
    } catch (err) {
      parsed = null;
      // A JSON syntax error means "not JSON" (an HTML page); anything else
      // means the body itself could not be read.
      unreadable = !(err instanceof SyntaxError);
    }
    const obj = asObject(parsed);
    if (typeof obj.message === "string") obj.message = scrubServerMessage(obj.message, this.creds.applicationPassword);
    return { status: res.status, body: parsed, location, unreadable };
  }
}

function redirectMessage(location: string | null): string {
  let host = "";
  try {
    if (location) host = new URL(location, "https://placeholder.invalid").host;
  } catch {
    host = "";
  }
  const where = host && host !== "placeholder.invalid" ? ` (to ${host})` : "";
  return `Your site redirected the request${where}. Reconnect using the exact address your site ends up at, for example with or without www.`;
}

/** Plain-language message for a failed authenticated API call. */
function failureMessage(res: ApiResponse, what: string): string {
  if (res.status >= 300 && res.status < 400) return redirectMessage(res.location);
  if (res.status === 401) return MSG_LOGIN_REFUSED;
  if (res.status === 403) return MSG_NO_PERMISSION;
  const detail = errorText(res.body);
  return detail ? `WordPress could not ${what}: ${detail}` : `WordPress could not ${what} (HTTP ${res.status}).`;
}

// ---- Content conversion -------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Public commenters control this text: an out-of-range or surrogate code point
// must stay as written instead of throwing.
function safeCodePoint(n: number, original: string): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return original;
  return String.fromCodePoint(n);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (m, n: string) => safeCodePoint(Number(n), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, h: string) => safeCodePoint(parseInt(h, 16), m))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Runs on ALREADY-escaped text, so the only markup in the output is what this
// function itself writes. The URL pattern stops at entity-encoded quotes and
// angle brackets so it can never swallow escaped characters into the href.
const URL_PATTERN = /https:\/\/(?:(?!&(?:quot|#39|lt|gt);)[^\s<])+/g;

function autolink(escaped: string): string {
  return escaped.replace(URL_PATTERN, (match) => {
    let url = match;
    let trailing = "";
    while (/[.,;:!?)\]]$/.test(url)) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    if (!url) return match;
    return `<a href="${url}" rel="noopener noreferrer">${url}</a>${trailing}`;
  });
}

/** Customer text to minimal, safe HTML: paragraphs on blank lines, <br> on
 *  single newlines, https URLs linked. Nothing from the customer is passed
 *  through as markup. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${autolink(escapeHtml(p)).replace(/\n/g, "<br>\n")}</p>`)
    .join("\n");
}

/** Title from options, else the first non-empty line (markdown heading marks
 *  stripped). The body is whatever remains when the first line became the
 *  title; if nothing remains, the full content. */
export function deriveTitleAndBody(content: string, optionTitle: string | undefined): { title: string; body: string } {
  const trimmedOption = optionTitle?.trim();
  if (trimmedOption) return { title: trimmedOption.slice(0, MAX_TITLE_LENGTH), body: content };
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const firstIndex = lines.findIndex((l) => l.trim() !== "");
  if (firstIndex === -1) return { title: "", body: content };
  const firstLine = lines[firstIndex].trim().replace(/^#{1,6}\s*/, "").trim();
  if (firstLine.length > MAX_TITLE_LENGTH) {
    // Too long to be a title: shorten it at a word boundary, but keep ALL the
    // text as the body so no part of the first line is lost.
    const cut = firstLine.slice(0, MAX_TITLE_LENGTH);
    const space = cut.lastIndexOf(" ");
    return { title: (space > 0 ? cut.slice(0, space) : cut).trim(), body: content };
  }
  const title = firstLine;
  const rest = lines.slice(firstIndex + 1).join("\n").trim();
  return { title, body: rest || content };
}

// ---- Media --------------------------------------------------------------

const EXT_TO_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};
const TYPE_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

function extensionOf(url: string): string {
  try {
    return new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1].toLowerCase() ?? "";
  } catch {
    return "";
  }
}

function uploadFilename(url: string, contentType: string): string {
  let base = "";
  try {
    base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    base = "";
  }
  base = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  if (base && /\.[A-Za-z0-9]{2,5}$/.test(base)) return base.slice(-100);
  const ext = TYPE_TO_EXT[contentType] ?? "jpg";
  return `${(base || `lazyrelay-${Date.now()}`).slice(0, 80)}.${ext}`;
}

interface UploadedMedia {
  id: number;
  sourceUrl: string;
  kind: "image" | "video";
}

async function uploadMedia(
  session: SiteSession,
  mediaUrl: string,
  altText: string | null,
): Promise<{ ok: true; media: UploadedMedia } | { ok: false; error: string }> {
  const media = await fetchMediaForStreaming(mediaUrl);
  if (!media) return { ok: false, error: `Could not fetch media from ${mediaUrl}` };

  let contentType = media.contentType.split(";")[0].trim().toLowerCase();
  const ext = extensionOf(mediaUrl);
  if ((!contentType || contentType === "application/octet-stream") && EXT_TO_TYPE[ext]) contentType = EXT_TO_TYPE[ext];
  const kind: "image" | "video" = contentType.startsWith("video/") || (!contentType.startsWith("image/") && EXT_TO_TYPE[ext]?.startsWith("video/")) ? "video" : "image";
  const filename = uploadFilename(mediaUrl, contentType);

  // WordPress's documented raw-upload form: the file is the request body and
  // the name travels in Content-Disposition.
  const headers: Record<string, string> = {
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Type": contentType || "application/octet-stream",
  };
  if (media.sizeBytes != null && Number.isFinite(media.sizeBytes)) headers["Content-Length"] = String(media.sizeBytes);

  const res = await session.request({ method: "POST", route: "/wp/v2/media", raw: { body: media.body, headers }, timeoutMs: UPLOAD_TIMEOUT_MS });
  const body = asObject(res.body);
  if (res.status !== 201 || typeof body.id !== "number") {
    if (res.status === 413) {
      return { ok: false, error: `WordPress refused the ${kind} because the file is larger than the site allows. Try a smaller file.` };
    }
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
      return { ok: false, error: failureMessage(res, `upload the ${kind}`) };
    }
    const detail = errorText(res.body);
    return {
      ok: false,
      error: `WordPress refused the ${kind} upload${detail ? `: ${detail}` : ` (HTTP ${res.status})`}. The site may not accept this file type or size.`,
    };
  }
  const sourceUrl = typeof body.source_url === "string" ? body.source_url : "";
  if (!sourceUrl) return { ok: false, error: "WordPress accepted the upload but did not return the file address." };

  if (altText) {
    // Best effort: the file is already uploaded, a missing alt text should not sink the post.
    await session.request({ method: "POST", route: `/wp/v2/media/${body.id}`, json: { alt_text: altText } }).catch(() => undefined);
  }
  return { ok: true, media: { id: body.id, sourceUrl, kind } };
}

// ---- Categories and tags ------------------------------------------------

/** Turns names into term ids: exact case-insensitive match first, otherwise
 *  create the term. Creating can be refused (categories need edit_terms, which
 *  Authors do not have), in which case the name is skipped, never a failure. */
async function resolveTerms(session: SiteSession, kind: "categories" | "tags", names: string[]): Promise<number[]> {
  const ids: number[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    try {
      const found = await session.request({ route: `/wp/v2/${kind}`, query: { search: name, per_page: "100", _fields: "id,name" } });
      if (found.status === 200 && Array.isArray(found.body)) {
        const match = (found.body as unknown[]).map(asObject).find((t) => typeof t.name === "string" && decodeEntities(t.name).toLowerCase() === name.toLowerCase());
        if (match && typeof match.id === "number") {
          ids.push(match.id);
          continue;
        }
      }
      const created = await session.request({ method: "POST", route: `/wp/v2/${kind}`, json: { name } });
      const createdBody = asObject(created.body);
      if (created.status === 201 && typeof createdBody.id === "number") {
        ids.push(createdBody.id);
      } else if (errorCode(created.body) === "term_exists") {
        // The search missed a term WordPress says exists (slug clash); it hands back the id.
        const existing = asObject(createdBody.data).term_id;
        if (typeof existing === "number") ids.push(existing);
      }
      // 403 and anything else: skip this name.
    } catch {
      // A failed lookup only costs this one label, not the post.
    }
  }
  return ids;
}

// ---- Public read-back ---------------------------------------------------

/** GET a public URL WITHOUT credentials, following a few redirects by hand so
 *  every hop goes through the SSRF guard. */
async function fetchPublic(url: string): Promise<{ status: number; text: string } | { error: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_PUBLIC_REDIRECTS; hop++) {
    const safety = await isSafeMediaUrl(current);
    if (!safety.safe) return { error: `the post address is not a safe public address (${safety.reason})` };
    const dispatcher = pinnedDispatcher(safety.addresses);
    try {
      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { Accept: "text/html", "User-Agent": "LazyRelay-ProofOfPublish/1.0" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        dispatcher,
      } as RequestInitWithDuplex);
      const location = res.headers?.get?.("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => undefined);
        current = new URL(location, current).toString();
        continue;
      }
      let text = "";
      if (res.status === 200) text = await readBodyText(res, MAX_PUBLIC_PAGE_BYTES, "truncate");
      else await res.body?.cancel().catch(() => undefined);
      return { status: res.status, text };
    } catch {
      return { error: "the public address could not be reached" };
    } finally {
      void dispatcher.close().catch(() => undefined);
    }
  }
  return { error: "the public address redirected too many times" };
}

/** After an unconfirmed create: look for a post with this exact title made in
 *  the last few minutes. context=edit exposes the raw (untexturized) title. */
async function findRecentPost(session: SiteSession, title: string): Promise<number | null> {
  const since = new Date(Date.now() - 10 * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  const res = await session.request({
    route: "/wp/v2/posts",
    query: { search: title, status: "any", per_page: "5", orderby: "date", after: since, context: "edit" },
  });
  if (res.status !== 200 || !Array.isArray(res.body)) return null;
  const wanted = title.trim().toLowerCase();
  for (const entry of res.body as unknown[]) {
    const post = asObject(entry);
    const t = asObject(post.title);
    const raw = typeof t.raw === "string" ? t.raw : typeof t.rendered === "string" ? decodeEntities(t.rendered) : "";
    if (typeof post.id === "number" && raw.trim().toLowerCase() === wanted) return post.id;
  }
  return null;
}

// ---- Adapter ------------------------------------------------------------

export class WordPressAdapter implements PlatformAdapter {
  readonly platform: "wordpress" = "wordpress";
  // The customer types the site and credentials on LazyRelay's own connect
  // page, so there is nothing to confirm afterwards (see connect.ts).
  readonly skipConnectConfirmation = true;

  constructor(private readonly connectPageUrl: string) {}

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({ state });
    return `${this.connectPageUrl}?${params.toString()}`;
  }

  // `code` is a JSON string {"siteUrl":"https://example.com","username":"...","applicationPassword":"xxxx xxxx ..."}.
  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    let input: { siteUrl?: unknown; username?: unknown; applicationPassword?: unknown };
    try {
      input = JSON.parse(code) as typeof input;
    } catch {
      throw new Error("WordPress connect needs the site address, your username and an application password.");
    }
    if (typeof input.siteUrl !== "string" || typeof input.username !== "string" || typeof input.applicationPassword !== "string") {
      throw new Error("WordPress connect needs the site address, your username and an application password.");
    }
    const username = input.username.trim();
    const applicationPassword = input.applicationPassword.trim();
    if (!username || !applicationPassword) {
      throw new Error("Enter both your WordPress username and the application password.");
    }
    const site = normalizeSiteUrl(input.siteUrl);
    if (!site.ok) throw new Error(site.error);

    const creds: WordPressCredentials = { siteUrl: site.siteUrl, username, applicationPassword };
    const opened = await SiteSession.open(creds);
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.session;

    try {
      // /users/me needs a valid login, so this one call proves the site, the
      // REST API and the credentials all work. context=edit adds capabilities.
      const probe = () => session.request({ route: "/wp/v2/users/me", query: { context: "edit" } });
      let res = await probe();
      if (res.status === 404 || (res.body === null && res.status < 300)) {
        session.useRestRoute = true;
        res = await probe();
      }

      const notWordPress =
        "That address does not look like a WordPress site with the REST API turned on. Check the address, or ask your host whether the REST API is blocked.";
      if (res.status >= 300 && res.status < 400) throw new Error(redirectMessage(res.location));
      if (res.status === 401) {
        const code401 = errorCode(res.body);
        if (code401 === "incorrect_password" || code401 === "invalid_username" || code401 === "invalid_email") {
          throw new Error("WordPress rejected that username or application password. Check both and try again. Use the application password, not your normal login password.");
        }
        if (code401.startsWith("application_passwords_disabled")) {
          throw new Error("Application Passwords are turned off on this site (a security plugin or setting disables them). Turn them on, then try again.");
        }
        // rest_not_logged_in: the login header was ignored entirely.
        throw new Error(
          "WordPress did not accept the login. Application Passwords may be turned off, or your host or a security plugin may be blocking the login header. Check both and try again.",
        );
      }
      if (res.status === 403) {
        throw new Error("The site refused the request (403). A security plugin or your host's firewall may be blocking access to the REST API.");
      }
      if (res.status >= 500) throw new Error(`Your site returned an error (HTTP ${res.status}). Try again in a few minutes.`);
      const me = asObject(res.body);
      if (res.status !== 200 || typeof me.id !== "number") throw new Error(notWordPress);

      const caps = asObject(me.capabilities);
      if (caps.edit_posts === false || caps.publish_posts === false) {
        throw new Error("That WordPress user cannot publish posts. Use a user with the Author role or higher (Contributors can only save drafts for review).");
      }

      const pathPart = new URL(creds.siteUrl).pathname.replace(/\/$/, "");
      const host = new URL(creds.siteUrl).host;
      const stored: WordPressCredentials = { ...creds, ...(session.useRestRoute ? { useRestRoute: true } : {}) };
      const friendlyUser = typeof me.name === "string" && me.name ? me.name : username;
      return {
        accessToken: JSON.stringify(stored),
        refreshToken: null,
        expiresAt: null,
        platformAccountId: `${host}${pathPart}:${username}`.toLowerCase(),
        displayName: `${friendlyUser} on ${host}${pathPart}`,
      };
    } finally {
      session.close();
    }
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const fail = (errorMessage: string): PostAttemptResult => ({ success: false, platformPostId: null, errorMessage });
    const creds = parseCredentials(request.accessToken);
    if (!creds) return fail(MSG_CORRUPT);

    const options = request.options?.wordpress ?? {};
    const { title, body } = deriveTitleAndBody(request.content, options.title);
    if (!title) return fail("WordPress needs a title or some text to publish.");

    const opened = await SiteSession.open(creds);
    if (!opened.ok) return fail(opened.error);
    const session = opened.session;

    try {
      const categoryIds = options.categories?.length ? await resolveTerms(session, "categories", options.categories) : [];
      const tagIds = options.tags?.length ? await resolveTerms(session, "tags", options.tags) : [];

      let html = textToHtml(body);
      let featuredMedia: number | undefined;

      // Uploads happen before the post exists, so a refused file stops the
      // whole thing instead of publishing a post missing its picture.
      if (request.mediaUrl) {
        const up = await uploadMedia(session, request.mediaUrl, request.mediaAltText ?? null);
        if (!up.ok) return fail(up.error);
        if (up.media.kind === "image") featuredMedia = up.media.id;
        else html += `\n<figure><video controls src="${escapeHtml(up.media.sourceUrl)}"></video></figure>`;
      }
      for (const extraUrl of request.mediaUrls ?? []) {
        const up = await uploadMedia(session, extraUrl, null);
        if (!up.ok) return fail(up.error);
        html +=
          up.media.kind === "image"
            ? `\n<figure><img src="${escapeHtml(up.media.sourceUrl)}" alt=""></figure>`
            : `\n<figure><video controls src="${escapeHtml(up.media.sourceUrl)}"></video></figure>`;
      }

      let res: ApiResponse | null = null;
      try {
        res = await session.request({
          method: "POST",
          route: "/wp/v2/posts",
          json: {
            title,
            content: html,
            status: options.status ?? "publish",
            ...(categoryIds.length ? { categories: categoryIds } : {}),
            ...(tagIds.length ? { tags: tagIds } : {}),
            ...(featuredMedia !== undefined ? { featured_media: featuredMedia } : {}),
          },
        });
      } catch {
        res = null; // timeout or dropped connection: the post may still have been created
      }
      if (!res || (res.status >= 200 && res.status < 300 && res.unreadable)) {
        // Do not just fail: the customer retrying would publish the post twice.
        const existing = await findRecentPost(session, title).catch(() => null);
        if (existing !== null) return { success: true, platformPostId: String(existing), errorMessage: null };
        return fail("WordPress did not confirm whether the post was created. Check the Posts list on your site before trying again, so it is not published twice.");
      }
      const created = asObject(res.body);
      if (res.status !== 201 || typeof created.id !== "number") return fail(failureMessage(res, "create the post"));
      return { success: true, platformPostId: String(created.id), errorMessage: null };
    } catch (err) {
      return fail(err instanceof Error ? err.message : "WordPress post failed");
    } finally {
      session.close();
    }
  }

  // "Live" here means what a stranger can see: WordPress must say the post is
  // published AND its public address must answer 200 without any login.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const notVerified = (errorMessage: string, platformPostUrl: string | null = null): VerifyResult => ({ verifiedLive: false, platformPostUrl, errorMessage });
    const creds = parseCredentials(accessToken);
    if (!creds) return notVerified(MSG_CORRUPT);
    if (!/^\d+$/.test(platformPostId)) return notVerified("The WordPress post id is not valid.");

    const opened = await SiteSession.open(creds);
    if (!opened.ok) return notVerified(opened.error);
    const session = opened.session;

    let link: string | null;
    let status: string;
    let passwordProtected = false;
    let postTitle = "";
    try {
      const res = await session.request({ route: `/wp/v2/posts/${platformPostId}`, query: { context: "edit" } });
      if (res.status === 404) return notVerified("The post was not found on your WordPress site. It may have been deleted.");
      const post = asObject(res.body);
      if (res.status !== 200 || typeof post.status !== "string") return notVerified(failureMessage(res, "read the post back"));
      status = post.status;
      link = typeof post.link === "string" ? post.link : null;
      passwordProtected = typeof post.password === "string" && post.password !== "";
      const t = asObject(post.title);
      postTitle = typeof t.raw === "string" ? t.raw : typeof t.rendered === "string" ? decodeEntities(t.rendered) : "";
    } catch (err) {
      return notVerified(err instanceof Error ? err.message : "Could not read the post back from WordPress.");
    } finally {
      session.close();
    }

    if (status === "draft") return { ...notVerified("Saved as a draft on WordPress as you chose, not published."), savedAsDraft: true };
    if (status === "future") return notVerified("WordPress has this post scheduled for later, so it is not live yet.");
    if (status === "pending") return notVerified("WordPress has this post waiting for review, so it is not live yet.");
    if (status === "private") return notVerified("WordPress has this post set to private, so the public cannot see it.");
    if (status !== "publish") return notVerified(`WordPress reports this post as "${status}", not published.`);
    if (passwordProtected) return notVerified("This post is password protected on WordPress, so the public sees a password form, not the post.");
    if (!link) return notVerified("WordPress published the post but did not return its address.");

    // A site with an https address can hand back an http link in its settings; read it back over https.
    let publicUrl = link;
    let slug = "";
    try {
      const parsed = new URL(link);
      // The link comes from the site itself; only trust it if it is the same site.
      if (parsed.hostname !== new URL(creds.siteUrl).hostname || (parsed.port !== "" && parsed.protocol === "https:")) {
        return notVerified(`WordPress returned a post address on a different host (${parsed.host}), so it cannot be confirmed as your site.`);
      }
      if (parsed.protocol === "http:") {
        parsed.protocol = "https:";
        publicUrl = parsed.toString();
      }
      slug = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "").toLowerCase();
    } catch {
      return notVerified("WordPress returned an address for the post that could not be read.");
    }

    const pub = await fetchPublic(publicUrl);
    if ("error" in pub) return notVerified(`WordPress says the post is published, but it could not be confirmed publicly: ${pub.error}.`, link);
    if (pub.status !== 200) {
      return notVerified(`WordPress says the post is published, but its public address answered HTTP ${pub.status} instead of showing the post.`, link);
    }
    // A bare 200 proves little (catch-all, maintenance or coming-soon pages), so
    // the page must actually mention this post by title or slug.
    const page = pub.text.toLowerCase();
    const needles = [postTitle.trim().toLowerCase(), escapeHtml(postTitle.trim()).toLowerCase(), slug].filter((n) => n.length > 0);
    if (needles.length === 0 || !needles.some((n) => page.includes(n))) {
      return notVerified("WordPress says the post is published, but its public page did not show the post (it may be a maintenance, coming-soon or error page).", link);
    }
    return { verifiedLive: true, platformPostUrl: link, errorMessage: null };
  }

  // Comments on the post, approved ones (what the public sees). The connected
  // user is authenticated, so WordPress may also include their own pending ones.
  async getComments(platformPostId: string, accessToken: string): Promise<CommentsResult> {
    const creds = parseCredentials(accessToken);
    if (!creds) return { comments: [], errorMessage: MSG_CORRUPT };
    const opened = await SiteSession.open(creds);
    if (!opened.ok) return { comments: [], errorMessage: opened.error };
    const session = opened.session;
    try {
      const res = await session.request({ route: "/wp/v2/comments", query: { post: platformPostId, per_page: "100", order: "asc" } });
      if (res.status !== 200 || !Array.isArray(res.body)) return { comments: [], errorMessage: failureMessage(res, "load comments") };
      const comments = (res.body as unknown[]).flatMap((entry) => {
        const c = asObject(entry);
        if (typeof c.id !== "number") return [];
        const rendered = asObject(c.content).rendered;
        return [
          {
            id: String(c.id),
            author: typeof c.author_name === "string" && c.author_name ? c.author_name : "Unknown",
            text: decodeEntities(typeof rendered === "string" ? rendered.replace(/<[^>]+>/g, "") : "").trim(),
            url: typeof c.link === "string" ? c.link : null,
            // date_gmt has no timezone marker; it is UTC.
            createdAt: typeof c.date_gmt === "string" && c.date_gmt ? `${c.date_gmt}Z` : null,
          },
        ];
      });
      return { comments, errorMessage: null };
    } catch (err) {
      return { comments: [], errorMessage: err instanceof Error ? err.message : "Could not load comments." };
    } finally {
      session.close();
    }
  }

  // Creating a comment needs the post id as well as the parent, and the
  // interface only gives us the comment id, so the parent is looked up first.
  async replyToComment(commentId: string, text: string, accessToken: string): Promise<CommentPostResult> {
    const creds = parseCredentials(accessToken);
    if (!creds) return { success: false, errorMessage: MSG_CORRUPT };
    if (!/^\d+$/.test(commentId)) return { success: false, errorMessage: "The WordPress comment id is not valid." };
    const opened = await SiteSession.open(creds);
    if (!opened.ok) return { success: false, errorMessage: opened.error };
    const session = opened.session;
    try {
      const parent = await session.request({ route: `/wp/v2/comments/${commentId}` });
      const parentBody = asObject(parent.body);
      if (parent.status !== 200 || typeof parentBody.post !== "number") {
        return { success: false, errorMessage: failureMessage(parent, "find the comment to reply to") };
      }
      // Escaped so a reply can never inject markup, whatever the user's capabilities.
      const res = await session.request({
        method: "POST",
        route: "/wp/v2/comments",
        json: { post: parentBody.post, parent: Number(commentId), content: escapeHtml(text) },
      });
      const created = asObject(res.body);
      if (res.status !== 201 || typeof created.id !== "number") return { success: false, errorMessage: failureMessage(res, "post the reply") };
      return { success: true, errorMessage: null };
    } catch (err) {
      return { success: false, errorMessage: err instanceof Error ? err.message : "WordPress reply failed." };
    } finally {
      session.close();
    }
  }
}
