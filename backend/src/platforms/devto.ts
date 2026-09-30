import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
  CommentsResult,
  PostMetrics,
} from "./types.js";

const DEVTO_API = "https://dev.to/api";
const TIMEOUT_MS = 30_000;

// dev.to's v1 API only answers when this Accept value is sent (older
// "api-key only" calls get the legacy behaviour). The docs page says an accept
// header is needed but does not print the value; this is the value Forem's own
// examples use.
const ACCEPT = "application/vnd.forem.api-v1+json";

// The docs state no title limit. 250 mirrors the database column Forem uses
// for titles, so we cut long first lines here instead of letting dev.to 422.
const MAX_TITLE_LENGTH = 250;
const MAX_TAGS = 4;
const RECENT_WINDOW_MS = 10 * 60_000;
const MAX_PAGE_BYTES = 64 * 1024;

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v|webm)(\?.*)?$/i.test(url);
}

// The stored credential is JSON {"apiKey": "..."}. A bare key string is also
// accepted so a hand-edited row still works.
function parseApiKey(accessToken: string): string | null {
  try {
    const parsed = JSON.parse(accessToken) as { apiKey?: unknown };
    if (parsed && typeof parsed.apiKey === "string" && parsed.apiKey.trim()) return parsed.apiKey.trim();
    return null;
  } catch {
    return accessToken.trim() && !accessToken.startsWith("{") ? accessToken.trim() : null;
  }
}

function headers(apiKey: string, withBody = false): Record<string, string> {
  return {
    "api-key": apiKey,
    Accept: ACCEPT,
    ...(withBody ? { "Content-Type": "application/json" } : {}),
  };
}

// dev.to tags: letters and digits only (dev.to strips or rejects everything
// else), lowercase, at most four.
export function normaliseTags(tags: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const tag = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

// Title and body. An explicit title keeps the whole text as the body;
// otherwise the first non-empty line becomes the title (leading markdown # and
// spaces stripped) and the remainder is the body.
export function deriveTitleAndBody(content: string, explicitTitle?: string): { title: string; body: string } {
  const full = content.trim();
  if (explicitTitle && explicitTitle.trim()) {
    return { title: explicitTitle.trim().slice(0, MAX_TITLE_LENGTH), body: full || explicitTitle.trim() };
  }
  const lines = full.split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx === -1) return { title: "", body: "" };
  const cleaned = lines[firstIdx].trim().replace(/^#+\s*/, "").trim();
  const title = cleaned.slice(0, MAX_TITLE_LENGTH).trim();
  // A first line longer than the cap is cut for the title, so the whole text
  // stays in the body rather than silently losing the overflow.
  if (cleaned.length > MAX_TITLE_LENGTH) return { title, body: full };
  const rest = lines.slice(firstIdx + 1).join("\n").trim();
  return { title, body: rest || cleaned };
}

// dev.to's own text is passed through, but the key is scrubbed from it, dashes
// are turned into plain hyphens and it is capped so a huge error page cannot
// flood a customer-facing message.
function scrub(text: string, apiKey: string): string {
  let out = text.replace(/[–—]/g, "-");
  if (apiKey) out = out.split(apiKey).join("[hidden]");
  return out.slice(0, 300);
}

function describeHttpError(
  status: number,
  json: { error?: unknown; message?: unknown } | null,
  action: string,
  apiKey = "",
): string {
  if (status === 401) return "dev.to refused the API key. Reconnect this account with a fresh key.";
  if (status === 429) return "dev.to is rate limiting this account. Try again in a minute or two.";
  const rawDetail = typeof json?.error === "string" ? json.error : typeof json?.message === "string" ? json.message : null;
  const detail = rawDetail ? scrub(rawDetail, apiKey) : null;
  if (status === 422) return detail ? `dev.to rejected the article: ${detail}` : "dev.to rejected the article (validation failed).";
  return detail ? `dev.to ${action} failed: ${detail}` : `dev.to ${action} failed (HTTP ${status}).`;
}

// Common HTML entities only; &amp; goes last so "&amp;lt;" stays "&lt;".
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

// Reads at most maxBytes of a response and cancels the rest.
async function readBounded(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  while (bytes < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    out += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  return out;
}

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface DevToUser {
  id?: number;
  username?: string;
  error?: string;
}

interface DevToArticle {
  id?: number;
  title?: string;
  url?: string | null;
  published?: boolean;
  created_at?: string;
  published_timestamp?: string;
  public_reactions_count?: number;
  comments_count?: number;
  page_views_count?: number;
  error?: string;
}

interface DevToComment {
  id_code?: string;
  body_html?: string;
  created_at?: string;
  user?: { name?: string; username?: string };
  children?: DevToComment[];
}

// dev.to has no OAuth for third parties writing articles: the customer creates
// an API key in dev.to Settings -> Extensions -> "DEV Community API Keys" and
// pastes it on LazyRelay's connect page (same shape as DiscordAdapter).
export class DevToAdapter implements PlatformAdapter {
  readonly platform: "devto" = "devto";
  // The customer pastes the key on LazyRelay's own connect page, so there is
  // nothing to confirm afterwards (see connect.ts).
  readonly skipConnectConfirmation = true;

  constructor(private readonly connectPageUrl: string) {}

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({ state });
    return `${this.connectPageUrl}?${params.toString()}`;
  }

  // `code` is a JSON string {"apiKey":"..."}.
  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    let apiKey: string;
    try {
      const parsed = JSON.parse(code) as { apiKey?: unknown };
      if (typeof parsed.apiKey !== "string" || !parsed.apiKey.trim()) throw new Error("missing field");
      apiKey = parsed.apiKey.trim();
    } catch {
      throw new Error("dev.to connect requires an API key");
    }

    let res: Response;
    try {
      res = await fetch(`${DEVTO_API}/users/me`, { headers: headers(apiKey), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new Error("Could not reach dev.to to check the API key. Try again in a moment.");
    }
    const json = await readJson<DevToUser>(res);
    if (!res.ok || !json || (json.id === undefined && !json.username)) {
      throw new Error(describeHttpError(res.status, json, "key check", apiKey));
    }

    return {
      accessToken: JSON.stringify({ apiKey }),
      refreshToken: null,
      expiresAt: null,
      platformAccountId: String(json.id ?? json.username),
      displayName: json.username ? `@${json.username}` : null,
    };
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const fail = (errorMessage: string): PostAttemptResult => ({ success: false, platformPostId: null, errorMessage });

    const apiKey = parseApiKey(request.accessToken);
    if (!apiKey) return fail("The saved dev.to key is unreadable. Reconnect this account.");

    const allMedia = [request.mediaUrl, ...(request.mediaUrls ?? [])].filter((u): u is string => !!u);
    if (allMedia.some(isVideoUrl)) return fail("dev.to does not accept video uploads through its API.");

    const options = request.options?.devto;
    const { title, body } = deriveTitleAndBody(request.content, options?.title);
    if (!title) return fail("dev.to needs a title, and the post text is empty.");

    // The API has no upload endpoint: the first image becomes the cover
    // (main_image) and any others are appended to the body as markdown images.
    let bodyMarkdown = body;
    const extras = (request.mediaUrls ?? []).filter((u) => u && u !== request.mediaUrl);
    if (extras.length > 0) {
      const alt = (request.mediaAltText ?? "").replace(/[\[\]\r\n]/g, " ").trim();
      bodyMarkdown += "\n\n" + extras.map((u) => `![${alt}](${u})`).join("\n");
    }

    const tags = normaliseTags(options?.tags);
    const article: Record<string, unknown> = {
      title,
      body_markdown: bodyMarkdown,
      published: options?.published ?? true,
      ...(tags.length > 0 ? { tags } : {}),
      ...(options?.series ? { series: options.series } : {}),
      ...(request.mediaUrl ? { main_image: request.mediaUrl } : {}),
      ...(options?.canonicalUrl ? { canonical_url: options.canonicalUrl } : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${DEVTO_API}/articles`, {
        method: "POST",
        headers: headers(apiKey, true),
        body: JSON.stringify({ article }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // A timeout or dropped connection does not prove dev.to skipped the
      // article, and the scheduler retries on failure. Look for it before
      // reporting failure so a retry cannot publish a duplicate.
      const existing = await this.findRecentArticle(apiKey, title);
      if (existing) return { success: true, platformPostId: existing, errorMessage: null };
      return fail(
        "dev.to did not confirm whether the article was created (the request timed out or dropped). Check your dev.to dashboard before retrying.",
      );
    }
    const json = await readJson<DevToArticle>(res);
    if (!res.ok || !json || json.id === undefined) {
      return fail(describeHttpError(res.status, json, "post", apiKey));
    }
    return { success: true, platformPostId: String(json.id), errorMessage: null };
  }

  // Same title created in the last few minutes on the author's own list. An
  // article with no usable timestamp is not matched: an old article with the
  // same title must not be mistaken for this one.
  private async findRecentArticle(apiKey: string, title: string): Promise<string | null> {
    try {
      const res = await fetch(`${DEVTO_API}/articles/me/all?per_page=30`, {
        headers: headers(apiKey),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const list = await readJson<DevToArticle[]>(res);
      if (!Array.isArray(list)) return null;
      const cutoff = Date.now() - RECENT_WINDOW_MS;
      const hit = list.find((a) => {
        const stamp = Date.parse(a.created_at ?? a.published_timestamp ?? "");
        return a.id !== undefined && a.title === title && Number.isFinite(stamp) && stamp >= cutoff;
      });
      return hit && hit.id !== undefined ? String(hit.id) : null;
    } catch {
      return null;
    }
  }

  // Drafts are invisible to the public GET /articles/{id}, so the author's own
  // list (GET /articles/me/all, published and unpublished together) is checked
  // first; the public endpoint is the fallback for articles beyond the first
  // page of that list. "Live" additionally needs the public URL to answer 200
  // without any credentials, which is what a reader would actually get.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const notConfirmed = (errorMessage: string): VerifyResult => ({ verifiedLive: false, platformPostUrl: null, errorMessage });
    const apiKey = parseApiKey(accessToken);
    if (!apiKey) return notConfirmed("The saved dev.to key is unreadable. Reconnect this account.");

    let article: DevToArticle | undefined;
    try {
      const listRes = await fetch(`${DEVTO_API}/articles/me/all?per_page=1000`, {
        headers: headers(apiKey),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (listRes.status === 401) return notConfirmed(describeHttpError(401, null, "check"));
      if (listRes.ok) {
        const list = await readJson<DevToArticle[]>(listRes);
        article = Array.isArray(list) ? list.find((a) => String(a.id) === platformPostId) : undefined;
      }
      if (!article) {
        const res = await fetch(`${DEVTO_API}/articles/${encodeURIComponent(platformPostId)}`, {
          headers: headers(apiKey),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // The public endpoint only ever returns published articles, and may
        // not repeat the flag, so its answer counts as published.
        if (res.ok) {
          const pub = await readJson<DevToArticle>(res);
          if (pub) article = { ...pub, published: pub.published ?? true };
        }
      }
    } catch {
      return notConfirmed("Could not reach dev.to to confirm the article.");
    }

    if (!article || article.id === undefined) return notConfirmed("dev.to could not find this article.");

    const url = article.url ?? null;
    if (article.published !== true) {
      // An explicit false is a deliberate draft; a missing field is unknown.
      if (article.published === false) {
        return { verifiedLive: false, platformPostUrl: url, errorMessage: "Saved as a draft on dev.to as you chose, not published.", savedAsDraft: true };
      }
      return { verifiedLive: false, platformPostUrl: url, errorMessage: "dev.to did not say whether this article is published." };
    }
    if (!url) return notConfirmed("dev.to did not return a public address for this article.");

    // The address comes from an API response, so only a plain https dev.to
    // page is ever fetched, and redirects are not followed.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return notConfirmed("dev.to returned an address that could not be read.");
    }
    if (parsed.protocol !== "https:" || (parsed.hostname !== "dev.to" && parsed.hostname !== "www.dev.to")) {
      return notConfirmed("dev.to returned an unexpected public address, so it was not checked.");
    }

    try {
      const pub = await fetch(parsed.toString(), { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (pub.status !== 200) {
        await pub.body?.cancel().catch(() => undefined);
        return { verifiedLive: false, platformPostUrl: url, errorMessage: `The article's public page did not load (HTTP ${pub.status}).` };
      }
      // A bare 200 is weak, so the page must mention this article: its path
      // (present in the canonical link) or its title.
      const lower = (await readBounded(pub, MAX_PAGE_BYTES)).toLowerCase();
      const path = parsed.pathname.toLowerCase();
      const title = (article.title ?? "").trim().toLowerCase();
      if (!((path.length > 1 && lower.includes(path)) || (title !== "" && lower.includes(title)))) {
        return { verifiedLive: false, platformPostUrl: url, errorMessage: "The public page loaded but does not look like this article." };
      }
    } catch {
      return { verifiedLive: false, platformPostUrl: url, errorMessage: "Could not load the article's public page to confirm it." };
    }
    return { verifiedLive: true, platformPostUrl: url, errorMessage: null };
  }

  // Public endpoint; the key is not needed. dev.to returns a tree (children),
  // flattened here so replies show up as comments too.
  async getComments(platformPostId: string, _accessToken: string): Promise<CommentsResult> {
    let res: Response;
    try {
      res = await fetch(`${DEVTO_API}/comments?a_id=${encodeURIComponent(platformPostId)}`, {
        headers: { Accept: ACCEPT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { comments: [], errorMessage: "Could not reach dev.to to load comments." };
    }
    const json = await readJson<DevToComment[] | { error?: string }>(res);
    if (!res.ok || !Array.isArray(json)) {
      return { comments: [], errorMessage: describeHttpError(res.status, Array.isArray(json) ? null : json, "comment load") };
    }

    const comments: CommentsResult["comments"] = [];
    const walk = (nodes: DevToComment[]) => {
      for (const c of nodes) {
        if (c.id_code) {
          comments.push({
            id: c.id_code,
            author: c.user?.name || c.user?.username || "Unknown",
            text: decodeEntities((c.body_html ?? "").replace(/<[^>]+>/g, "")).trim(),
            url: null,
            createdAt: c.created_at ?? null,
          });
        }
        if (c.children?.length) walk(c.children);
      }
    };
    walk(json);
    return { comments, errorMessage: null };
  }

  // Missing fields stay null: dev.to does not always return page_views_count
  // (it is only shown to the author), and unknown must never read as zero.
  async getPostMetrics(platformPostId: string, accessToken: string): Promise<PostMetrics> {
    const empty = (errorMessage: string): PostMetrics => ({ likes: null, comments: null, shares: null, views: null, errorMessage });
    const apiKey = parseApiKey(accessToken);
    if (!apiKey) return empty("The saved dev.to key is unreadable. Reconnect this account.");

    let res: Response;
    try {
      res = await fetch(`${DEVTO_API}/articles/${encodeURIComponent(platformPostId)}`, {
        headers: headers(apiKey),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return empty("Could not reach dev.to to load metrics.");
    }
    const json = await readJson<DevToArticle>(res);
    if (!res.ok || !json || json.id === undefined) return empty(describeHttpError(res.status, json, "metrics load", apiKey));

    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      likes: num(json.public_reactions_count),
      comments: num(json.comments_count),
      shares: null, // dev.to has no share count
      views: num(json.page_views_count),
      errorMessage: null,
    };
  }
}
