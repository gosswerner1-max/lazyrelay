import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
  CommentsResult,
  PostMetrics,
} from "./types.js";
import { isSafeMediaUrl } from "../urlSafety.js";

// Endpoint. Checked live on 2026-09-30: https://gql-beta.hashnode.com/ answers
// POST GraphQL and anonymous introspection, and Hashnode's own apidocs.hashnode.com
// redirects there. https://gql.hashnode.com/ (the older documented address) answers
// a POST with a 301 to a "GraphQL API is moving to a paid offering" page, which no
// GraphQL client can follow, so it is deliberately not used.
const HASHNODE_API = "https://gql-beta.hashnode.com/";
const TIMEOUT_MS = 30_000;

// PublishPostInput.title is required and Hashnode's own editor caps titles at
// 250 characters; the shared options check (postOptions.ts) uses the same number.
const MAX_TITLE_LENGTH = 250;
// The schema says up to 15 tags, but LazyRelay's option check allows 5 and Hashnode's
// editor shows 5, so 5 is the cap here as well.
const MAX_TAGS = 5;
const MAX_PUBLICATIONS_LISTED = 20;
const MAX_COMMENTS = 50;

const REFUSED_TOKEN = "Hashnode refused the token. Reconnect this account.";
const NEEDS_PRO =
  "This Hashnode blog needs a Pro plan before its API works. Upgrade under Billing in the Hashnode dashboard, then try again.";
const UNCONFIRMED =
  "Hashnode did not answer, so it is unclear whether the article was created. Check your Hashnode blog before trying again.";
const CORRUPT ="The saved Hashnode connection is damaged. Reconnect this account.";

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v|webm)(\?.*)?$/i.test(url);
}

interface HashnodeCredentials {
  token: string;
  publicationId: string;
}

// The stored credential is JSON {"token","publicationId"}. Returns null when it is
// missing a field so callers can answer with a plain message instead of throwing.
function parseCredentials(accessToken: string): HashnodeCredentials | null {
  try {
    const parsed = JSON.parse(accessToken) as Partial<HashnodeCredentials>;
    if (typeof parsed.token === "string" && parsed.token && typeof parsed.publicationId === "string" && parsed.publicationId) {
      return { token: parsed.token, publicationId: parsed.publicationId };
    }
    return null;
  } catch {
    return null;
  }
}

interface GraphQLError {
  message?: string;
  extensions?: { code?: string };
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: GraphQLError[];
}

interface GqlResult<T> {
  status: number;
  json: GraphQLResponse<T> | null;
  networkError: boolean;
}

// The Authorization header is the raw personal access token, which is how Hashnode
// has always documented it. A newer third-party listing says "Bearer <token>", and
// the live endpoint answers both a junk raw token and a junk Bearer token with the
// same UNAUTHENTICATED error, so the difference cannot be proven without a real
// token. So: try raw first, and only if Hashnode says "not logged in" try once with
// the Bearer prefix. An unauthenticated call has no side effects, so the retry can
// never double-post.
async function rawGql<T>(token: string | null, scheme: "raw" | "bearer", query: string, variables: Record<string, unknown>): Promise<GqlResult<T>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = scheme === "bearer" ? `Bearer ${token}` : token;
  try {
    const res = await fetch(HASHNODE_API, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as GraphQLResponse<T> | null;
    return { status: res.status, json, networkError: false };
  } catch {
    return { status: 0, json: null, networkError: true };
  }
}

function isUnauthenticated(r: GqlResult<unknown>): boolean {
  return r.status === 401 || (r.json?.errors ?? []).some((e) => e.extensions?.code === "UNAUTHENTICATED");
}

async function gql<T>(token: string, query: string, variables: Record<string, unknown> = {}): Promise<GqlResult<T>> {
  const first = await rawGql<T>(token, "raw", query, variables);
  if (!isUnauthenticated(first)) return first;
  const second = await rawGql<T>(token, "bearer", query, variables);
  return isUnauthenticated(second) ? first : second;
}

// Turns a failed call into one plain sentence. Returns null when the call worked.
// The token is scrubbed from anything Hashnode echoes back, and dashes are turned
// into hyphens so no long dash reaches a customer.
function failureMessage(r: GqlResult<unknown>, token: string, action: string): string | null {
  if (r.networkError) return "Could not reach Hashnode. Try again in a few minutes.";
  const errors = r.json?.errors ?? [];
  if (r.status === 401 || errors.some((e) => e.extensions?.code === "UNAUTHENTICATED")) return REFUSED_TOKEN;
  if (r.status === 429) return "Hashnode is rate limiting this account. Try again in a minute or two.";
  const text = errors.map((e) => e.message ?? "").join(" ");
  // The Pro-plan message is only for a permission-style refusal (FORBIDDEN or HTTP 403).
  // An ordinary error that merely mentions "subscription" or "plan" is passed on as is.
  const forbidden = errors.some((e) => e.extensions?.code === "FORBIDDEN") || r.status === 403;
  if (forbidden) {
    if (/\bpro\b|upgrade|billing|allow-?list|subscription|plan\b/i.test(text)) return NEEDS_PRO;
    return "Hashnode says this token is not allowed to do that on this blog. Reconnect with a token from the blog owner's account.";
  }
  if (errors.length > 0) {
    const detail = errors[0].message ?? "unknown error";
    return `Hashnode could not ${action}: ${scrub(detail, token)}`;
  }
  if (r.status >= 400 || !r.json) return `Hashnode could not ${action} (HTTP ${r.status})`;
  return null;
}

function scrub(text: string, token: string): string {
  let out = text.replace(/[–—]/g, "-");
  if (token) out = out.split(token).join("[hidden]");
  return out.slice(0, 300);
}

// A publication address the customer typed (blog.hashnode.dev, https://blog.hashnode.dev/,
// a custom domain) compared against the host part of each publication's url.
function normaliseHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

// Hashnode tag slugs: lowercase letters, digits and hyphens.
export function slugifyTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildTags(tags: string[] | undefined): { slug: string; name: string }[] {
  const out: { slug: string; name: string }[] = [];
  for (const raw of tags ?? []) {
    const slug = slugifyTag(raw);
    if (!slug || out.some((t) => t.slug === slug)) continue;
    out.push({ slug, name: raw.trim().replace(/^#+/, "") });
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

// Title and body. An explicit title keeps the whole text as the body; otherwise the
// first non-empty line becomes the title (leading markdown # stripped) and the rest
// is the body. A first line longer than the title limit is cut for the title but the
// whole text stays in the body so nothing is lost. Hashnode rejects an empty body, so
// a title-only post uses the title as its body.
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
  if (cleaned.length > MAX_TITLE_LENGTH) return { title, body: full };
  const rest = lines.slice(firstIdx + 1).join("\n").trim();
  return { title, body: rest || cleaned };
}

const MAX_REDIRECTS = 3;
const PAGE_READ_BYTES = 64 * 1024;

// Reads at most `limit` bytes of a response body as text, then cancels the rest.
async function readBounded(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, limit));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// The page counts as the article when the title (HTML entities decoded) or the slug shows up.
function pageMentions(html: string, title: string, slug: string): boolean {
  const page = squash(decodeEntities(html));
  if (title.trim() && page.includes(squash(decodeEntities(title)))) return true;
  return !!slug.trim() && page.includes(slug.trim().toLowerCase());
}

function markdownAlt(alt: string): string {
  return alt.replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim() || "Image";
}

interface PublicationNode {
  id?: string;
  title?: string;
  url?: string | null;
}

export class HashnodeAdapter implements PlatformAdapter {
  readonly platform: "hashnode" = "hashnode";
  // The customer pastes a personal access token on LazyRelay's own connect page,
  // so there is nothing to confirm afterwards (see connect.ts).
  readonly skipConnectConfirmation = true;

  constructor(private readonly connectPageUrl: string) {}

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({ state });
    return `${this.connectPageUrl}?${params.toString()}`;
  }

  // `code` is JSON: {"token":"<personal access token>","publicationHost":"optional.hashnode.dev"}.
  // A Hashnode account can own several blogs, and a post always goes to one of them,
  // so the publication is picked here and stored next to the token.
  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    let token: string;
    let publicationHost: string;
    try {
      const parsed = JSON.parse(code) as { token?: unknown; publicationHost?: unknown };
      if (typeof parsed.token !== "string" || !parsed.token.trim()) throw new Error("missing field");
      token = parsed.token.trim();
      publicationHost = typeof parsed.publicationHost === "string" ? normaliseHost(parsed.publicationHost) : "";
    } catch {
      throw new Error("Hashnode connect needs a personal access token");
    }

    const query = `query { me { id username publications(first: ${MAX_PUBLICATIONS_LISTED}) { edges { node { id title url } } } } }`;
    const res = await gql<{ me?: { publications?: { edges?: { node?: PublicationNode }[] } } | null }>(token, query);
    const failure = failureMessage(res, token, "check that token");
    if (failure) throw new Error(failure);
    const me = res.json?.data?.me;
    if (!me) throw new Error(REFUSED_TOKEN);

    const publications = (me.publications?.edges ?? []).map((e) => e.node).filter((n): n is PublicationNode => !!n && !!n.id);
    if (publications.length === 0) {
      throw new Error("That Hashnode account has no blog yet. Create a blog on Hashnode first, then connect again.");
    }

    let chosen: PublicationNode | undefined;
    if (publicationHost) {
      chosen = publications.find((p) => p.url && normaliseHost(p.url) === publicationHost);
      if (!chosen) {
        throw new Error("Could not find a blog with that address on this Hashnode account. Check the blog address and try again.");
      }
    } else if (publications.length === 1) {
      chosen = publications[0];
    } else {
      throw new Error("This Hashnode account has more than one blog. Enter the address of the blog to post to, for example yourname.hashnode.dev.");
    }

    const publicationId = chosen.id as string;
    const host = chosen.url ? normaliseHost(chosen.url) : "";
    const title = chosen.title || "Hashnode blog";
    return {
      accessToken: JSON.stringify({ token, publicationId } satisfies HashnodeCredentials),
      refreshToken: null,
      expiresAt: null,
      platformAccountId: publicationId,
      displayName: host ? `${title} (${host})` : title,
    };
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const fail = (errorMessage: string): PostAttemptResult => ({ success: false, platformPostId: null, errorMessage });
    const creds = parseCredentials(request.accessToken);
    if (!creds) return fail(CORRUPT);

    const allMedia = [...(request.mediaUrl ? [request.mediaUrl] : []), ...(request.mediaUrls ?? [])];
    if (allMedia.some(isVideoUrl)) {
      return fail("Hashnode articles cannot carry a video file here. Remove the video or link to it in the text.");
    }

    const options = request.options?.hashnode;
    const { title, body } = deriveTitleAndBody(request.content ?? "", options?.title);
    if (!title) return fail("Hashnode needs some text for the article title.");

    // The first image is the cover. Any further images go at the end of the article
    // as markdown images, with the post's alt text when there is one.
    const alt = markdownAlt(request.mediaAltText ?? "");
    // The cover is not repeated in the body when the same URL also sits in mediaUrls.
    const inline = (request.mediaUrls ?? []).filter((url) => url !== request.mediaUrl).map((url) => `![${alt}](${url})`);
    const contentMarkdown = inline.length > 0 ? `${body}\n\n${inline.join("\n\n")}` : body;

    const tags = buildTags(options?.tags);
    const isDraft = options?.draft === true;

    // The two inputs differ in the live schema: PublishPostInput takes a plain
    // `coverImage` URL, CreateDraftInput takes `coverImageOptions { coverImageURL }`.
    const input: Record<string, unknown> = {
      publicationId: creds.publicationId,
      title,
      contentMarkdown,
      ...(options?.subtitle ? { subtitle: options.subtitle } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(options?.canonicalUrl ? { originalArticleURL: options.canonicalUrl } : {}),
    };
    if (request.mediaUrl) {
      if (isDraft) input.coverImageOptions = { coverImageURL: request.mediaUrl };
      else input.coverImage = request.mediaUrl;
    }

    // Only `id` is selected, so a failing extra subfield can never turn a created post
    // into a reported failure. If an id came back, the post exists, whatever else the
    // response says.
    if (isDraft) {
      const res = await gql<{ createDraft?: { draft?: { id?: string } } | null }>(
        creds.token,
        "mutation CreateDraft($input: CreateDraftInput!) { createDraft(input: $input) { draft { id } } }",
        { input },
      );
      const id = res.json?.data?.createDraft?.draft?.id;
      if (id) return { success: true, platformPostId: `draft:${id}`, errorMessage: null };
      if (res.networkError || res.status >= 500) {
        const found = await this.findRecent(creds, title, "drafts");
        if (found) return { success: true, platformPostId: `draft:${found}`, errorMessage: null };
        return fail(UNCONFIRMED);
      }
      return fail(failureMessage(res, creds.token, "save the draft") ?? "Hashnode did not confirm the draft was saved.");
    }

    const res = await gql<{ publishPost?: { post?: { id?: string } } | null }>(
      creds.token,
      "mutation PublishPost($input: PublishPostInput!) { publishPost(input: $input) { post { id } } }",
      { input },
    );
    const id = res.json?.data?.publishPost?.post?.id;
    if (id) return { success: true, platformPostId: id, errorMessage: null };
    if (res.networkError || res.status >= 500) {
      const found = await this.findRecent(creds, title, "posts");
      if (found) return { success: true, platformPostId: found, errorMessage: null };
      return fail(UNCONFIRMED);
    }
    return fail(failureMessage(res, creds.token, "publish the article") ?? "Hashnode did not confirm the article was published.");
  }

  // After a timeout or dropped connection Hashnode may still have created the post,
  // and the scheduler would retry and post it twice. Look at the blog's newest posts
  // (or drafts) for the same title created in the last 10 minutes. Returns the id, or
  // null when nothing matches or the lookup itself fails.
  private async findRecent(creds: HashnodeCredentials, title: string, kind: "posts" | "drafts"): Promise<string | null> {
    const stamp = kind === "posts" ? "publishedAt" : "updatedAt";
    const res = await gql<{ publication?: Record<string, { edges?: { node?: { id?: string; title?: string | null; publishedAt?: string; updatedAt?: string } }[] } | undefined> | null }>(
      creds.token,
      `query Recent($id: ObjectId!) { publication(id: $id) { ${kind}(first: 5) { edges { node { id title ${stamp} } } } } }`,
      { id: creds.publicationId },
    );
    if (res.networkError || res.json?.errors?.length) return null;
    const wanted = title.trim().toLowerCase();
    for (const edge of res.json?.data?.publication?.[kind]?.edges ?? []) {
      const node = edge.node;
      if (!node?.id || (node.title ?? "").trim().toLowerCase() !== wanted) continue;
      const ms = Date.parse(node[stamp] ?? "");
      if (Number.isFinite(ms) && Date.now() - ms < 10 * 60_000) return node.id;
    }
    return null;
  }

  // Proof of publish: read the post back from Hashnode, require that it has a public
  // address and a publish time that has passed, then ask that address the way an
  // ordinary visitor would (no token) and require HTTP 200.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const notVerified = (errorMessage: string, platformPostUrl: string | null = null): VerifyResult => ({
      verifiedLive: false,
      platformPostUrl,
      errorMessage,
    });
    const creds = parseCredentials(accessToken);
    if (!creds) return notVerified(CORRUPT);

    if (platformPostId.startsWith("draft:")) {
      const draftId = platformPostId.slice("draft:".length);
      const res = await gql<{ draft?: { id?: string } | null }>(creds.token, "query Draft($id: ObjectId!) { draft(id: $id) { id } }", { id: draftId });
      const failure = failureMessage(res, creds.token, "look up the draft");
      if (failure) return notVerified(failure);
      if (!res.json?.data?.draft?.id) return notVerified("The draft could not be found on Hashnode. It may have been deleted there.");
      return notVerified("Saved as a draft on Hashnode as you chose, not published");
    }

    const res = await gql<{ post?: { id?: string; url?: string | null; publishedAt?: string | null; title?: string | null; slug?: string | null } | null }>(
      creds.token,
      "query Post($id: ID!) { post(id: $id) { id url publishedAt title slug } }",
      { id: platformPostId },
    );
    const failure = failureMessage(res, creds.token, "look up the article");
    if (failure) return notVerified(failure);
    const post = res.json?.data?.post;
    if (!post || !post.id) return notVerified("Hashnode does not show this article. It may have been removed.");
    if (!post.url) return notVerified("Hashnode did not return a public address for this article.");
    const publishedMs = post.publishedAt ? Date.parse(post.publishedAt) : NaN;
    if (!Number.isFinite(publishedMs) || publishedMs > Date.now() + 60_000) {
      return notVerified("Hashnode has this article but it is not published yet.", post.url);
    }

    const page = await this.checkPublicPage(post.url, post.title ?? "", post.slug ?? "");
    if (page) return notVerified(page, post.url);
    return { verifiedLive: true, platformPostUrl: post.url, errorMessage: null };
  }

  // Asks the article's public address the way a visitor would (no token). Returns null
  // when the page is really the article, otherwise a plain reason.
  //  - Redirects are followed by hand, at most 3 hops. Every hop address goes through the
  //    SSRF guard, and the final page must be on the same host as the address Hashnode
  //    gave, so a custom domain cannot bounce us to an internal address.
  //  - The guard checks DNS and then fetch resolves again, so the connection is NOT pinned
  //    to the checked address the way streamUpload.ts does it. The response is only ever
  //    read for text (64 KB), never forwarded, which limits what a rebinding could leak.
  //  - A bare 200 is not enough (a parked custom domain answers 200), so the page must
  //    mention the article's title or its slug.
  private async checkPublicPage(startUrl: string, title: string, slug: string): Promise<string | null> {
    const startHost = new URL(startUrl).host;
    let url = startUrl;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const safety = await isSafeMediaUrl(url);
        if (!safety.safe) return "The article address Hashnode returned could not be checked safely.";
        const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel().catch(() => undefined);
          const location = res.headers.get("location");
          if (!location || hop === MAX_REDIRECTS) return "Hashnode lists the article but its public address redirects too many times.";
          url = new URL(location, url).toString();
          continue;
        }
        if (res.status !== 200) {
          await res.body?.cancel().catch(() => undefined);
          return `Hashnode lists the article but its public page answered HTTP ${res.status}.`;
        }
        if (new URL(url).host !== startHost) {
          await res.body?.cancel().catch(() => undefined);
          return "Hashnode lists the article but its public address leads to a different website.";
        }
        const text = await readBounded(res, PAGE_READ_BYTES);
        if (!pageMentions(text, title, slug)) {
          return "The public page answered but does not show this article's title, so it is not confirmed live.";
        }
        return null;
      }
    } catch {
      return "Hashnode lists the article but its public page could not be reached.";
    }
    return "Hashnode lists the article but its public page could not be confirmed.";
  }

  // The post node exposes views, reactionCount and responseCount in the live schema.
  // Shares are not exposed, so they stay null rather than 0.
  async getPostMetrics(platformPostId: string, accessToken: string): Promise<PostMetrics> {
    const empty = (errorMessage: string): PostMetrics => ({ likes: null, comments: null, shares: null, views: null, errorMessage });
    const creds = parseCredentials(accessToken);
    if (!creds) return empty(CORRUPT);
    if (platformPostId.startsWith("draft:")) return empty("A draft has no metrics yet.");
    const res = await gql<{ post?: { views?: number | null; reactionCount?: number | null; responseCount?: number | null } | null }>(
      creds.token,
      "query Metrics($id: ID!) { post(id: $id) { views reactionCount responseCount } }",
      { id: platformPostId },
    );
    const failure = failureMessage(res, creds.token, "load metrics");
    if (failure) return empty(failure);
    const post = res.json?.data?.post;
    if (!post) return empty("Hashnode does not show this article.");
    return {
      likes: post.reactionCount ?? null,
      comments: post.responseCount ?? null,
      shares: null,
      views: post.views ?? null,
      errorMessage: null,
    };
  }

  async getComments(platformPostId: string, accessToken: string): Promise<CommentsResult> {
    const creds = parseCredentials(accessToken);
    if (!creds) return { comments: [], errorMessage: CORRUPT };
    if (platformPostId.startsWith("draft:")) return { comments: [], errorMessage: null };
    type CommentNode = { id?: string; content?: { text?: string }; author?: { name?: string; username?: string }; dateAdded?: string };
    const res = await gql<{ post?: { url?: string | null; comments?: { edges?: { node?: CommentNode }[] } } | null }>(
      creds.token,
      `query Comments($id: ID!) { post(id: $id) { url comments(first: ${MAX_COMMENTS}) { edges { node { id dateAdded content { text } author { name username } } } } } }`,
      { id: platformPostId },
    );
    const failure = failureMessage(res, creds.token, "load comments");
    if (failure) return { comments: [], errorMessage: failure };
    const post = res.json?.data?.post;
    if (!post) return { comments: [], errorMessage: "Hashnode does not show this article." };
    const comments = (post.comments?.edges ?? []).flatMap((e) => {
      const n = e.node;
      if (!n?.id) return [];
      return [
        {
          id: n.id,
          author: n.author?.name || n.author?.username || "Unknown",
          text: (n.content?.text ?? "").trim(),
          url: post.url ?? null,
          createdAt: n.dateAdded ?? null,
        },
      ];
    });
    return { comments, errorMessage: null };
  }
}
