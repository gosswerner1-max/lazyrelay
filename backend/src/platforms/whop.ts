import { createHash } from "node:crypto";
import type { PlatformAdapter, PostRequest, PostAttemptResult, VerifyResult, OAuthExchangeResult, PendingConnectSelection } from "./types.js";
import {
  APP_ID,
  COMPANY_ID,
  EXPERIENCE_ID,
  POST_ID,
  WHOP_TEXT_LIMIT,
  WHOP_UNREACHABLE,
  WhopApiError,
  WhopClient,
  failureText,
  whopPostUrl,
} from "./whopApi.js";
import { WHOP_TOKEN_PLACEHOLDER, claimWhopCompany, parseHeldWhopConnect } from "./whopConnect.js";

// Whop (whop.com, a marketplace of creator communities). Checked against Whop's official docs on 2026-10-01:
//   Forum posts   https://docs.whop.com/api-reference/forum-posts/create-forum-post  (+ list and retrieve)
//   Experiences   https://docs.whop.com/api-reference/experiences/list-experiences
//   Idempotency   https://docs.whop.com/developer/api/idempotency   (header Idempotency-Key, all authenticated POSTs)
//   Errors/limits https://docs.whop.com/developer/api/errors, .../rate-limits  (600 requests per minute per operation)
//   Webhooks      https://docs.whop.com/developer/guides/webhooks   (no app install or uninstall event is documented)
//
// LazyRelay has ONE Whop app (private, installed by a community owner from its direct install link, three permissions:
// forum:post:create, forum:read, experience:hidden_experience:read). Unlike every other platform there is NO per
// customer secret: the credential is the app's single API key from the environment (WHOP_APP_API_KEY), which only
// works in communities that installed the app. So:
//   - a connected account stores only ids and a label: platform_account_id = "<company id>:<forum experience id>",
//     display_name = "Forums (Community name)". The vault token LazyRelay's account row points at is a harmless
//     placeholder (WHOP_TOKEN_PLACEHOLDER); post() and verifyPublished() ignore whatever token they are handed.
//   - because the key is shared, connecting a community requires PROOF the customer owns it (whopConnect.ts).
//
// v1 posts TEXT (Markdown) to ONE forum. No images or video: Whop's file flow is not built (platformRules, mediaLimits).
//
// Proof of publish: POST /forum_posts, then GET /forum_posts/{id}. The post is only called live when the id matches,
// parent_id is null (a top-level post, not a comment) and the content read back equals what was sent. verifyPublished
// only receives the post id, so the id carries everything it needs:
//   platformPostId = "<company id>:<forum id>:<post id>:<first 16 hex of sha256 of the sent text>"
// The proof link (https://whop.com/<route>/<forum id>/app/posts/<post id>/, confirmed in a browser 2026-10-01) uses the
// community's CURRENT route, read from the experiences list, so a renamed community still links correctly.

const HASH_LENGTH = 16;
const ZERO_WIDTH_SPACE = "​";

/** The text exactly as sent to Whop, and the form both sides of the read-back are compared in.
 *  - Line endings become \n and the ends are trimmed, which is what a stored post looks like.
 *  - "<@" is broken with an invisible space. Whop's docs describe no mention syntax for the API, but the `<@name>`
 *    form is what an editor produces; this makes sure customer text can never turn into a mention by accident.
 *    (LazyRelay also never sends is_mention, the field that makes Whop notify people.) */
export function normalizeWhopText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/<@/g, `<${ZERO_WIDTH_SPACE}@`).trim();
}

const contentHash = (normalized: string): string => createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, HASH_LENGTH);

/** "<company id>:<forum id>" (the stored platform_account_id) back into its two parts, or null. */
export function parseWhopAccountId(value: string | null | undefined): { companyId: string; experienceId: string } | null {
  if (!value) return null;
  const [companyId, experienceId, extra] = value.split(":");
  if (extra !== undefined || !companyId || !experienceId || !COMPANY_ID.test(companyId) || !EXPERIENCE_ID.test(experienceId)) return null;
  return { companyId, experienceId };
}

export function parseWhopPostId(value: string): { companyId: string; experienceId: string; postId: string; hash: string } | null {
  const [companyId, experienceId, postId, hash, extra] = value.split(":");
  if (extra !== undefined || !companyId || !experienceId || !postId || !hash) return null;
  if (!COMPANY_ID.test(companyId) || !EXPERIENCE_ID.test(experienceId) || !POST_ID.test(postId) || !new RegExp(`^[0-9a-f]{${HASH_LENGTH}}$`).test(hash)) return null;
  return { companyId, experienceId, postId, hash };
}

export class WhopAdapter implements PlatformAdapter {
  readonly platform: "whop" = "whop";
  // One forum per connection; a second forum means connecting again (and proving ownership again).
  readonly singleSelection = true;
  /** Used by the connect routes; the key stays inside the client. */
  readonly api: WhopClient;
  // 429 answers rotate the idempotency key (see idempotencyKeyFor). In memory on purpose: it only has to survive the
  // few minutes between a rate-limited attempt and its retry.
  private readonly rateLimitedKeys = new Map<string, number>();

  constructor(apiKey: string, readonly appId: string) {
    if (!APP_ID.test(appId)) throw new Error("WHOP_APP_ID is not a Whop app id (it starts with app_)");
    this.api = new WhopClient(apiKey);
  }

  /** Where a community owner installs the LazyRelay app (no store listing needed). */
  get installUrl(): string {
    return `https://whop.com/apps/${this.appId}/install`;
  }

  // Whop connects through its own steps (whopConnect.ts and routes/whopConnect.routes.ts), never through a redirect.
  async getAuthorizeUrl(): Promise<string> {
    throw new Error("Whop is connected from its own connect dialog in Social Platforms, not through a sign-in redirect.");
  }

  // Contract only: the picker (listConnectOptions) is never used because the proof step creates the pending selection.
  async exchangeCode(): Promise<OAuthExchangeResult> {
    throw new Error("Whop is connected from its own connect dialog in Social Platforms.");
  }

  async listConnectOptions(): Promise<PendingConnectSelection> {
    throw new Error("Whop is connected from its own connect dialog in Social Platforms.");
  }

  /** Final step of connecting: the customer picked a forum. The community comes from the proof LazyRelay is holding
   *  (never from the browser), the forum must still exist in that community, and the community is claimed for the
   *  account that proved it, which is refused when another account holds it. */
  async finalizeConnectOption(userToken: string, selectedId: string): Promise<OAuthExchangeResult> {
    const held = parseHeldWhopConnect(userToken);
    if (!held) throw new Error("The held Whop connection is damaged, please start again");
    const target = parseWhopAccountId(selectedId);
    if (!target || target.companyId !== held.companyId) throw new Error("That forum is not in the community you proved you own, please start again");
    let forumLabel = "";
    try {
      const list = await this.api.listForums(held.companyId);
      forumLabel = list.forums.find((f) => f.id === target.experienceId)?.label ?? "";
    } catch {
      throw new Error("Could not check your forum with Whop. Please start again in a moment.");
    }
    if (!forumLabel) throw new Error("That forum is no longer available, please start again");
    await claimWhopCompany(held.companyId, held.accountId);
    return {
      accessToken: WHOP_TOKEN_PLACEHOLDER,
      refreshToken: null,
      expiresAt: null,
      platformAccountId: `${target.companyId}:${target.experienceId}`,
      displayName: forumLabel,
    };
  }

  // The same post always gets the same key, so a retry after a lost answer cannot post twice (Whop replays the stored
  // response for 24 hours). One exception: Whop also replays stored ERRORS for a key, so after a 429, which
  // definitely did NOT create the post, the next attempt gets a fresh key or it would replay "rate limited" for a day.
  private idempotencyKeyFor(request: PostRequest, normalized: string): string {
    const base = request.scheduledPostId ? `lazyrelay-post-${request.scheduledPostId}` : `lazyrelay-text-${createHash("sha256").update(`${request.socialAccountId}\n${normalized}`).digest("hex").slice(0, 40)}`;
    const generation = this.rateLimitedKeys.get(base) ?? 0;
    return generation > 0 ? `${base}-r${generation}` : base;
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const fail = (errorMessage: string): PostAttemptResult => ({ success: false, platformPostId: null, errorMessage });

    const target = parseWhopAccountId(request.platformAccountId);
    if (!target) return fail("Whop post failed: whop_not_found (this connection has no forum saved)");
    if (request.mediaUrl || (request.mediaUrls?.length ?? 0) > 0) {
      return fail("Whop posts through LazyRelay are text only (whop_text_only): remove the image or video");
    }
    const content = normalizeWhopText(request.content);
    if (!content) return fail("Whop post failed: whop_empty");
    if (content.length > WHOP_TEXT_LIMIT) return fail("Whop post failed: whop_too_long");

    const key = this.idempotencyKeyFor(request, content);
    const baseKey = key.replace(/-r\d+$/, "");
    let reply;
    try {
      // is_mention is never sent: LazyRelay posts never notify members.
      reply = await this.api.request("POST", "/forum_posts", { json: { experience_id: target.experienceId, content }, idempotencyKey: key });
    } catch {
      // The answer may have been lost AFTER Whop created the post. The key stays the same, so the retry cannot duplicate it.
      return fail(WHOP_UNREACHABLE);
    }
    if (reply.status === 429) this.rateLimitedKeys.set(baseKey, (this.rateLimitedKeys.get(baseKey) ?? 0) + 1);
    if (reply.status < 200 || reply.status >= 300) return fail(failureText("post", reply));

    const postId = typeof reply.json.id === "string" ? reply.json.id : "";
    if (!POST_ID.test(postId)) return fail("Whop accepted the post but did not return a post id");
    this.rateLimitedKeys.delete(baseKey);
    return { success: true, platformPostId: `${target.companyId}:${target.experienceId}:${postId}:${contentHash(content)}`, errorMessage: null };
  }

  async verifyPublished(platformPostId: string): Promise<VerifyResult> {
    const parsed = parseWhopPostId(platformPostId);
    if (!parsed) return { verifiedLive: false, platformPostUrl: null, errorMessage: `Not a valid Whop post id: ${platformPostId.slice(0, 60)}` };
    const unconfirmed = (why: string): VerifyResult => ({ verifiedLive: false, platformPostUrl: null, errorMessage: `Whop post whop_unconfirmed (${why})` });

    let reply;
    try {
      reply = await this.api.request("GET", `/forum_posts/${parsed.postId}`);
    } catch {
      return { verifiedLive: false, platformPostUrl: null, errorMessage: WHOP_UNREACHABLE };
    }
    // A 404 right after creating is read-after-write lag (or a moderator already removed it): either way it is not
    // confirmed, and it must never become a reconnect request or a second post, so it gets its own code.
    if (reply.status === 404) return unconfirmed("Whop does not show the post yet");
    if (reply.status < 200 || reply.status >= 300) return { verifiedLive: false, platformPostUrl: null, errorMessage: failureText("confirmation", reply) };

    const body = reply.json as { id?: unknown; parent_id?: unknown; content?: unknown };
    if (body.id !== parsed.postId) return unconfirmed("Whop returned a different post");
    if (body.parent_id !== null && body.parent_id !== undefined) return unconfirmed("the post is a comment, not a top-level post");
    if (typeof body.content !== "string" || contentHash(normalizeWhopText(body.content)) !== parsed.hash) {
      return unconfirmed("the text Whop shows is not the text that was sent");
    }

    // The link needs the community's current route. If it cannot be read the post is still confirmed (Whop just
    // returned it), only the link is missing.
    let url: string | null = null;
    try {
      const list = await this.api.listForums(parsed.companyId);
      url = whopPostUrl(list.routeByExperience.get(parsed.experienceId) ?? list.companyRoute, parsed.experienceId, parsed.postId);
    } catch {
      url = null;
    }
    return { verifiedLive: true, platformPostUrl: url, errorMessage: null };
  }
}
