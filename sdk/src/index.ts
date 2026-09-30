import { HttpClient, type LazyRelayOptions } from "./http.js";
import { LazyRelayError } from "./errors.js";
import type {
  AnalyticsQuery,
  AnalyticsSummary,
  Brand,
  CreateDraftInput,
  CreateReviewLinkInput,
  CreateRssFeedInput,
  CreatedReviewLink,
  Deleted,
  DuplicatePostInput,
  FeedbackList,
  ListPostsQuery,
  MediaUpload,
  MediaUploadOptions,
  Mentions,
  NextSlot,
  PinterestBoard,
  PlatformRules,
  PostHistoryQuery,
  PostingSlotList,
  ProofLink,
  PublishNowInput,
  ReviewComment,
  ReviewLink,
  ReviewLinkList,
  Revoked,
  RssFeed,
  RssFeedList,
  ScheduleDraftInput,
  ScheduledPost,
  SchedulePostInput,
  SnippetList,
  SocialAccount,
  TikTokCreatorInfo,
  UpdatePostInput,
  UploadableFile,
} from "./types.js";

export * from "./types.js";
export { LazyRelayError, describeApiError, type ErrorKind, type ErrorInfo } from "./errors.js";
export type { LazyRelayOptions } from "./http.js";
export {
  verifyWebhookSignature,
  type VerifyWebhookSignatureInput,
  WEBHOOK_EVENTS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_ATTEMPT_HEADER,
} from "./webhook.js";
export { VERSION, DEFAULT_BASE_URL } from "./version.js";

const enc = encodeURIComponent;
const REVIEW_PAGE_BASE = "https://lazyrelay.com/review";
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

const toIso = (value: string | Date): string => (value instanceof Date ? value.toISOString() : value);

/** Converts the Date-or-string time fields of a request body to ISO strings. */
function withTimes<T extends { scheduledFor?: string | Date | null }>(input: T): Omit<T, "scheduledFor"> & { scheduledFor?: string | null } {
  if (input.scheduledFor === undefined || input.scheduledFor === null || typeof input.scheduledFor === "string") {
    return input as Omit<T, "scheduledFor"> & { scheduledFor?: string | null };
  }
  return { ...input, scheduledFor: input.scheduledFor.toISOString() };
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  pdf: "application/pdf",
};

/** Guesses a MIME type from a file name. The API ignores it and detects the real type from the bytes. */
export function guessContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

class Accounts {
  constructor(private readonly http: HttpClient) {}
  /** Every connected social account, with the id the posting methods need. */
  list(): Promise<SocialAccount[]> {
    return this.http.request("GET", "/social-accounts");
  }
}

class Brands {
  constructor(private readonly http: HttpClient) {}
  /** The account's brands (workspaces). */
  list(): Promise<Brand[]> {
    return this.http.request("GET", "/brands");
  }
}

class Rules {
  constructor(private readonly http: HttpClient) {}
  /** What a platform accepts before you post: text limit, media rules, required fields, options. Leave platform out for all of them. */
  get(platform?: string): Promise<PlatformRules> {
    return this.http.request("GET", "/platforms/rules", { query: { platform } });
  }
}

class Posts {
  constructor(private readonly http: HttpClient) {}

  /** Schedule a post to ONE connected account. Call once per account to post to several. */
  schedule(input: SchedulePostInput): Promise<ScheduledPost> {
    return this.http.request("POST", "/scheduled-posts", { body: withTimes(input) });
  }

  /**
   * Publish to one account right away. The scheduler picks it up within moments: it is not
   * published synchronously. Call list() afterwards and check post_results[0].verified_live.
   */
  publishNow(input: PublishNowInput): Promise<ScheduledPost> {
    return this.http.request("POST", "/scheduled-posts", { body: { ...input, scheduledFor: new Date().toISOString() } });
  }

  /**
   * Upcoming posts (pending, posting, needs_approval, draft) plus the 50 most recent posted or
   * failed ones. The API does not filter, so status, socialAccountId and limit are applied here.
   * Use history() to page further back.
   */
  async list(query: ListPostsQuery = {}): Promise<ScheduledPost[]> {
    const all = await this.http.request<ScheduledPost[]>("GET", "/scheduled-posts", { query: { brand: query.brand } });
    const filtered = all.filter((p) => (!query.status || p.status === query.status) && (!query.socialAccountId || p.social_account_id === query.socialAccountId));
    return query.limit === undefined ? filtered : filtered.slice(0, query.limit);
  }

  /** Older posted and failed posts, newest first, one page at a time. */
  history(query: PostHistoryQuery = {}): Promise<ScheduledPost[]> {
    return this.http.request("GET", "/scheduled-posts/history", { query: { limit: query.limit, before: query.before } });
  }

  /** Edit a draft, a post waiting for approval or a still-pending post. Use reschedule() to change the time. */
  update(id: string, input: UpdatePostInput): Promise<ScheduledPost> {
    return this.http.request("PATCH", `/scheduled-posts/${enc(id)}`, { body: input });
  }

  /** Cancel a pending post, or clear a posted, failed or draft one. A post being published right now cannot be deleted. */
  async delete(id: string): Promise<void> {
    await this.http.request("DELETE", `/scheduled-posts/${enc(id)}`);
  }

  /** Approve a post that is waiting for approval, so it is scheduled. */
  approve(id: string): Promise<ScheduledPost> {
    return this.http.request("PATCH", `/scheduled-posts/${enc(id)}/approve`);
  }

  /** A public link that shows a post was confirmed live. The API key must be allowed to share proof. */
  proofLink(id: string): Promise<ProofLink> {
    return this.http.request("GET", `/scheduled-posts/${enc(id)}/proof-link`);
  }

  /** Copy a post to a new time. The copy is a new standalone post. */
  duplicate(id: string, input: DuplicatePostInput): Promise<ScheduledPost> {
    return this.http.request("POST", `/scheduled-posts/${enc(id)}/duplicate`, { body: withTimes(input) });
  }

  /** Save a post as a draft without choosing an account or a time yet. */
  createDraft(input: CreateDraftInput): Promise<ScheduledPost> {
    return this.http.request("POST", "/scheduled-posts/draft", { body: withTimes(input) });
  }

  /** Turn a draft into a scheduled post by choosing the account and the time. The platform rules are checked now. */
  scheduleDraft(id: string, input: ScheduleDraftInput): Promise<ScheduledPost> {
    return this.http.request("PATCH", `/scheduled-posts/${enc(id)}/schedule`, { body: withTimes(input) });
  }

  /** Move a pending post to a new time. */
  reschedule(id: string, scheduledFor: string | Date): Promise<ScheduledPost> {
    return this.http.request("PATCH", `/scheduled-posts/${enc(id)}/reschedule`, { body: { scheduledFor: toIso(scheduledFor) } });
  }

  /** Hold a pending post without cancelling it. */
  pause(id: string): Promise<ScheduledPost> {
    return this.http.request("PATCH", `/scheduled-posts/${enc(id)}/pause`);
  }

  /** Release a paused post. */
  resume(id: string): Promise<ScheduledPost> {
    return this.http.request("PATCH", `/scheduled-posts/${enc(id)}/resume`);
  }
}

class Media {
  constructor(private readonly http: HttpClient) {}

  /**
   * Upload an image, video or PDF and get back a public URL to use as mediaUrl.
   * `file` is a Blob or File, a Buffer or Uint8Array (give options.filename), or a path to a local file.
   */
  async upload(file: UploadableFile, options: MediaUploadOptions = {}): Promise<MediaUpload> {
    let blob: Blob;
    let filename: string;
    if (typeof file === "string") {
      const [{ readFile }, { basename }] = await Promise.all([import("node:fs/promises"), import("node:path")]);
      let bytes: Buffer;
      try {
        bytes = await readFile(file);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        throw LazyRelayError.local("validation", code === "ENOENT" ? `File not found: ${file}` : `Could not read ${file}: ${(err as Error).message}`);
      }
      filename = options.filename ?? basename(file);
      blob = new Blob([bytes as unknown as BlobPart], { type: options.contentType ?? guessContentType(filename) });
    } else if (file instanceof Blob) {
      filename = options.filename ?? (file as Blob & { name?: string }).name ?? "upload";
      blob = options.contentType && options.contentType !== file.type ? new Blob([file], { type: options.contentType }) : file;
    } else {
      if (!options.filename) {
        throw LazyRelayError.local("validation", "media.upload needs options.filename when the file is a Buffer, Uint8Array or ArrayBuffer.");
      }
      filename = options.filename;
      blob = new Blob([file as unknown as BlobPart], { type: options.contentType ?? guessContentType(filename) });
    }
    const form = new FormData();
    form.append("file", blob, filename);
    if (options.altText !== undefined) form.append("altText", options.altText);
    return this.http.request("POST", "/media/upload", { form, timeoutMs: options.timeoutMs ?? Math.max(this.http.timeoutMs, UPLOAD_TIMEOUT_MS) });
  }
}

class Slots {
  constructor(private readonly http: HttpClient) {}
  /** The posting times saved in Settings. */
  list(): Promise<PostingSlotList> {
    return this.http.request("GET", "/posting-slots");
  }
  /** The next free posting time for one account, as an ISO timestamp to use as scheduledFor. Fails with not_found if no times are saved. */
  next(socialAccountId: string): Promise<NextSlot> {
    return this.http.request("GET", "/posting-slots/next", { query: { socialAccountId } });
  }
}

class Snippets {
  constructor(private readonly http: HttpClient) {}
  /** Saved text snippets (hashtag groups, sign-offs) and which one is the signature. */
  list(): Promise<SnippetList> {
    return this.http.request("GET", "/snippets");
  }
}

class TikTok {
  constructor(private readonly http: HttpClient) {}
  /** What one TikTok account allows: privacy levels, whether it can post now, the longest video. Call before posting to TikTok. */
  creatorInfo(accountId: string): Promise<TikTokCreatorInfo> {
    return this.http.request("GET", `/social-accounts/${enc(accountId)}/tiktok-creator-info`);
  }
}

class Pinterest {
  constructor(private readonly http: HttpClient) {}
  /** A Pinterest account's boards. A Pinterest post needs a boardId from this list. Other platforms return an empty list. */
  boards(accountId: string): Promise<PinterestBoard[]> {
    return this.http.request("GET", `/social-accounts/${enc(accountId)}/boards`);
  }
}

class Analytics {
  constructor(private readonly http: HttpClient) {}
  /** Post counts, verified-live rate, per-platform breakdown and engagement for a recent window. */
  summary(query: AnalyticsQuery = {}): Promise<AnalyticsSummary> {
    return this.http.request("GET", "/analytics/summary", { query: { days: query.days, brand: query.brand, tag: query.tag } });
  }
}

class MentionsApi {
  constructor(private readonly http: HttpClient) {}
  /** Recent comments on your posts, on the platforms LazyRelay can read them from. */
  list(): Promise<Mentions> {
    return this.http.request("GET", "/mentions");
  }
}

class ReviewLinks {
  constructor(private readonly http: HttpClient) {}
  /** Client review links with their status and how many the plan allows. */
  list(): Promise<ReviewLinkList> {
    return this.http.request("GET", "/review-links");
  }
  /** Create a link a client opens (no account needed) to approve posts. `url` is the address to send them. Needs a plan with review links. */
  async create(input: CreateReviewLinkInput = {}): Promise<CreatedReviewLink> {
    const link = await this.http.request<ReviewLink>("POST", "/review-links", { body: input });
    return { ...link, url: `${REVIEW_PAGE_BASE}/${link.token}` };
  }
  /** Stop a review link working at once. */
  revoke(id: string): Promise<Revoked> {
    return this.http.request("DELETE", `/review-links/${enc(id)}`);
  }
}

class Feedback {
  constructor(private readonly http: HttpClient) {}
  /** The client conversation on a post. */
  list(postId: string): Promise<FeedbackList> {
    return this.http.request("GET", `/scheduled-posts/${enc(postId)}/review-comments`);
  }
  /** Reply in the client conversation on a post, up to 1000 characters. The client sees it on their review page. */
  reply(postId: string, body: string): Promise<ReviewComment> {
    return this.http.request("POST", `/scheduled-posts/${enc(postId)}/review-comments`, { body: { body } });
  }
}

class RssFeeds {
  constructor(private readonly http: HttpClient) {}
  /** RSS feeds whose new items become drafts. */
  list(): Promise<RssFeedList> {
    return this.http.request("GET", "/rss-feeds");
  }
  /** Add a feed. The address is fetched and checked first. Needs a paid plan. */
  create(input: CreateRssFeedInput): Promise<RssFeed> {
    return this.http.request("POST", "/rss-feeds", { body: input });
  }
  /** Pause or resume a feed. */
  setEnabled(id: string, enabled: boolean): Promise<RssFeed> {
    return this.http.request("PATCH", `/rss-feeds/${enc(id)}`, { body: { enabled } });
  }
  delete(id: string): Promise<Deleted> {
    return this.http.request("DELETE", `/rss-feeds/${enc(id)}`);
  }
}

/** The LazyRelay client. A thin typed layer over the REST API. */
export class LazyRelay {
  readonly accounts: Accounts;
  readonly brands: Brands;
  readonly rules: Rules;
  readonly posts: Posts;
  readonly media: Media;
  readonly slots: Slots;
  readonly snippets: Snippets;
  readonly tiktok: TikTok;
  readonly pinterest: Pinterest;
  readonly analytics: Analytics;
  readonly mentions: MentionsApi;
  readonly reviewLinks: ReviewLinks;
  readonly feedback: Feedback;
  readonly rssFeeds: RssFeeds;

  constructor(options: LazyRelayOptions = {}) {
    const http = new HttpClient(options);
    this.accounts = new Accounts(http);
    this.brands = new Brands(http);
    this.rules = new Rules(http);
    this.posts = new Posts(http);
    this.media = new Media(http);
    this.slots = new Slots(http);
    this.snippets = new Snippets(http);
    this.tiktok = new TikTok(http);
    this.pinterest = new Pinterest(http);
    this.analytics = new Analytics(http);
    this.mentions = new MentionsApi(http);
    this.reviewLinks = new ReviewLinks(http);
    this.feedback = new Feedback(http);
    this.rssFeeds = new RssFeeds(http);
  }
}

export default LazyRelay;
