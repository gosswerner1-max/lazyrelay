// Request and response shapes. Response types mirror what the REST API returns (see
// frontend/src/lib/api.ts in the LazyRelay repo). Fields the API adds later are kept out of the
// way: every response type only promises the fields listed here.

// ---- Platform options (backend/src/postOptions.ts)

/** Platform-specific settings. Send only the key that belongs to the account's platform. */
export interface PostOptions {
  tiktok?: { aiGenerated?: boolean };
  youtube?: {
    title?: string;
    privacy?: "public" | "unlisted" | "private";
    madeForKids?: boolean;
    tags?: string[];
    aiGenerated?: boolean;
  };
  instagram?: {
    placement?: "feed" | "reel" | "story";
    /** A trial reel is shown to non-followers first. Reels only. */
    trialReel?: boolean;
    trialGraduation?: "manual" | "auto";
  };
  facebook?: { placement?: "feed" | "story" };
  linkedin?: { documentUrl?: string; documentTitle?: string };
  /** Follow-up posts that reply to the main post in order (a thread). Threads, Bluesky, Mastodon and X. */
  chain?: string[];
}

export type TikTokPrivacyLevel = "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "SELF_ONLY";

export type PostStatus = "draft" | "needs_approval" | "pending" | "posting" | "posted" | "failed";

// ---- Post requests

/** The fields every post-shaped request shares. */
export interface PostFields {
  /** A publicly accessible image or video URL. Use media.upload() to get one from a local file. */
  mediaUrl?: string;
  /** Extra images after mediaUrl for a multi-image post. */
  mediaUrls?: string[];
  /** A still cover image for a video (Pinterest video pins need one). */
  coverImageUrl?: string;
  /** Accessibility description of the main image (Mastodon and Bluesky use it). */
  mediaAltText?: string;
  /** A first comment posted right after publishing (Facebook and Instagram only). */
  firstComment?: string;
  /** Minutes to wait after the post goes live before posting firstComment (0 to 1440; Facebook and Instagram only). 0 or left out posts it right away. */
  firstCommentDelayMinutes?: number;
  /** Up to 5 short labels for filtering analytics by campaign. */
  tags?: string[];
  /** A follow-up comment added once the post reaches selfReplyAtLikes likes (Facebook and Instagram only). */
  selfReplyText?: string;
  selfReplyAtLikes?: number;
  /** Pinterest only: the board to pin to. Get it from pinterest.boards(). */
  boardId?: string;
  /** Pinterest only: where a click on the pin goes. */
  destinationLink?: string;
  /** TikTok only, required for TikTok. Get the allowed levels from tiktok.creatorInfo(). */
  tiktokPrivacyLevel?: TikTokPrivacyLevel;
  /** TikTok only: turn comments off (default true, comments off). */
  tiktokDisableComment?: boolean;
  tiktokDisableDuet?: boolean;
  tiktokDisableStitch?: boolean;
  /** TikTok only: the video promotes the creator's own brand. */
  tiktokBrandOrganic?: boolean;
  /** TikTok only: the video is a paid partnership. */
  tiktokBrandContent?: boolean;
  options?: PostOptions;
}

export interface SchedulePostInput extends PostFields {
  /** The connected account to post to (accounts.list()). One post goes to one account. */
  socialAccountId: string;
  content: string;
  /** When to post: an ISO 8601 string or a Date. Up to a minute in the past is tolerated. */
  scheduledFor: string | Date;
  /** Hold the post until someone approves it. */
  requiresApproval?: boolean;
}

export interface PublishNowInput extends PostFields {
  socialAccountId: string;
  content: string;
  requiresApproval?: boolean;
}

export interface CreateDraftInput extends PostFields {
  content: string;
  /** Anchor the draft to a calendar day, YYYY-MM-DD. */
  plannedDate?: string | null;
  /** Pre-selected accounts, advisory only until the draft is scheduled. */
  plannedAccountIds?: string[] | null;
  scheduledFor?: string | Date | null;
}

/** Fields you can change on a draft, an awaiting-approval post or a still-pending post. null clears a text field. */
export interface UpdatePostInput {
  content?: string;
  mediaUrl?: string | null;
  mediaUrls?: string[];
  coverImageUrl?: string | null;
  mediaAltText?: string | null;
  firstComment?: string | null;
  firstCommentDelayMinutes?: number | null;
  tags?: string[];
  selfReplyText?: string | null;
  selfReplyAtLikes?: number | null;
  boardId?: string | null;
  destinationLink?: string | null;
  tiktokPrivacyLevel?: TikTokPrivacyLevel | null;
  tiktokDisableComment?: boolean;
  tiktokDisableDuet?: boolean;
  tiktokDisableStitch?: boolean;
  tiktokBrandOrganic?: boolean;
  tiktokBrandContent?: boolean;
  plannedDate?: string | null;
  options?: PostOptions;
}

/** Turns a draft into a real scheduled post: same fields as posts.schedule(). */
export type ScheduleDraftInput = SchedulePostInput;

export interface DuplicatePostInput {
  scheduledFor: string | Date;
  requiresApproval?: boolean;
}

export interface ListPostsQuery {
  status?: PostStatus;
  socialAccountId?: string;
  /** At most this many posts. The list is filtered on the client, so this applies after status and account. */
  limit?: number;
  /** Only posts for accounts of this brand (the API's own brand filter). */
  brand?: string;
}

export interface PostHistoryQuery {
  /** 1 to 100, default 50. */
  limit?: number;
  /** An ISO scheduled_for timestamp: only posts older than this. */
  before?: string;
}

// ---- Post responses

export interface PostResult {
  verified_live: boolean;
  platform_post_url: string | null;
  error_message: string | null;
  raw_error_message?: string | null;
  chain_posted?: number | null;
  chain_error?: string | null;
}

/** A post row as the API returns it (snake_case, exactly as stored). */
export interface ScheduledPost {
  id: string;
  account_id?: string;
  social_account_id: string | null;
  content: string;
  media_url: string | null;
  cover_image_url: string | null;
  board_id: string | null;
  destination_link: string | null;
  first_comment: string | null;
  first_comment_delay_minutes?: number | null;
  media_alt_text: string | null;
  tags?: string[] | null;
  media_urls?: string[] | null;
  self_reply_text?: string | null;
  self_reply_at_likes?: number | null;
  self_reply_done_at?: string | null;
  self_reply_error?: string | null;
  changes_requested_at?: string | null;
  options?: PostOptions | null;
  tiktok_privacy_level: string | null;
  tiktok_disable_comment: boolean;
  tiktok_disable_duet: boolean;
  tiktok_disable_stitch: boolean;
  tiktok_brand_organic: boolean;
  tiktok_brand_content: boolean;
  scheduled_for: string | null;
  planned_date: string | null;
  planned_account_ids: string[] | null;
  status: PostStatus;
  paused_at: string | null;
  google_event_id: string | null;
  created_at?: string;
  /** Present on list and history responses, newest attempt first. */
  post_results?: PostResult[];
}

export interface ProofLink {
  url: string;
}

// ---- Accounts, brands, rules

export interface SocialAccount {
  id: string;
  platform: string;
  platform_account_id: string;
  display_name: string | null;
  connected_at: string;
  /** Set when only the account owner can renew the connection. */
  needs_reconnect_at?: string | null;
  brand_label: string | null;
  brand_id: string | null;
}

export interface Brand {
  id: string;
  name: string;
  voice_profile: string | null;
  created_at: string;
}

export interface PlatformRuleSet {
  platform: string;
  label: string;
  text: { maxLength: number | null; note: string };
  media: {
    textOnlyAllowed: boolean;
    image: { supported: boolean; formats: string[]; maxSizeMb: number | null };
    video: { supported: boolean; formats: string[]; maxSizeMb: number | null; maxDurationSec: number | null };
    multiItem: { maxItems: number; videosAllowed: boolean } | null;
    notes: string;
  };
  /** Post fields that must be sent for this platform, in the API's own field names. */
  required: string[];
  features: string[];
  /** "<options key>: what it does". */
  options: string[];
  limits: { rollingPostsPer24h: number | null; note: string };
  lookups: string[];
  notes: string[];
  sources: string[];
}

export interface PlatformRules {
  platforms: PlatformRuleSet[];
}

export interface TikTokCreatorInfo {
  nickname: string | null;
  maxVideoDurationSec: number | null;
  canPost: boolean;
  cantPostReason: string | null;
  /** The privacy levels this account can use. */
  privacyLevelOptions: string[];
}

export interface PinterestBoard {
  id: string;
  name: string;
}

// ---- Media

export interface MediaUpload {
  id: string;
  url: string;
  altText: string | null;
}

export interface MediaUploadOptions {
  /** Accessibility description, up to 1000 characters. */
  altText?: string;
  /** The file name to send. Required for a Buffer or Uint8Array. */
  filename?: string;
  /** Overrides the type guessed from the file name. The API detects the real type from the bytes. */
  contentType?: string;
  /** Upload timeout in milliseconds. Default 10 minutes (files can be up to 1 GB). */
  timeoutMs?: number;
}

/** A Blob (or File), a Buffer or Uint8Array (give options.filename), or a path to a local file. */
export type UploadableFile = Blob | Uint8Array | ArrayBuffer | string;

// ---- Posting times, snippets

export interface PostingSlot {
  id: string;
  /** ISO weekdays, 1 = Monday to 7 = Sunday. */
  daysOfWeek: number[];
  /** 24 hour HH:MM. */
  timeOfDay: string;
  timezone: string;
}

export interface PostingSlotList {
  maxSlots: number;
  slots: PostingSlot[];
}

export interface NextSlot {
  scheduledFor: string;
}

export interface Snippet {
  id: string;
  name: string;
  content: string;
  isSignature: boolean;
  createdAt: string;
}

export interface SnippetList {
  maxSnippets: number;
  snippets: Snippet[];
}

// ---- Analytics, mentions

export interface AnalyticsQuery {
  /** 1 to 90. The API defaults to 30. */
  days?: number;
  brand?: string;
  tag?: string;
}

export interface AnalyticsSummary {
  rangeDays: number;
  availableTags?: string[];
  totalPosts: number;
  byStatus: Record<string, number>;
  byPlatform: Record<string, { total: number; posted: number; failed: number; verifiedLive: number }>;
  dailyCounts: Record<string, number>;
  dailyCountsByPlatform?: Record<string, Record<string, number>>;
  verifiedLiveRate: number | null;
  dmCount?: number;
  accountsConnected?: number;
  /** Only present for platforms LazyRelay can read metrics from. */
  engagement: Record<string, { likes: number; comments: number; shares: number; views: number; postsWithData: number }>;
  audienceGrowth?: Record<string, { trend: { date: string; followerCount: number }[]; netChange: number | null }>;
}

export interface Triage {
  needsAttention: boolean;
  category: "angry_customer" | "sales_question" | "question" | "routine";
  reason: string;
}

export interface MentionComment {
  id: string;
  author: string;
  text: string;
  url: string | null;
  createdAt: string | null;
  triage?: Triage | null;
}

export interface MentionPost {
  postId: string;
  socialAccountId: string;
  platform: string;
  content: string;
  scheduledFor: string;
  platformPostUrl: string | null;
  supported: boolean;
  canReply?: boolean;
  comments: MentionComment[];
  errorMessage?: string | null;
}

export interface Mentions {
  posts: MentionPost[];
}

// ---- Client review links and feedback

export interface ReviewLink {
  id: string;
  token: string;
  label: string | null;
  brandLabel: string | null;
  expiresAt: string;
  lastViewedAt: string | null;
  createdAt: string;
  status: "active" | "expired" | "revoked";
}

/** What reviewLinks.create() returns: the API's link plus the public address to send a client. */
export interface CreatedReviewLink extends ReviewLink {
  url: string;
}

export interface ReviewLinkList {
  maxLinks: number;
  links: ReviewLink[];
}

export interface CreateReviewLinkInput {
  /** Who it is for, up to 60 characters. */
  label?: string;
  /** Only show posts for this brand. */
  brandLabel?: string;
  /** 1 to 90, default 30. */
  expiresInDays?: number;
}

export interface ReviewComment {
  id?: string;
  authorKind: "reviewer" | "owner";
  authorName: string;
  kind: "comment" | "approved" | "changes_requested" | "updated";
  body: string | null;
  createdAt: string;
}

export interface FeedbackList {
  comments: ReviewComment[];
}

// ---- RSS feeds

export interface RssFeed {
  id: string;
  url: string;
  label: string | null;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface RssFeedList {
  maxFeeds: number;
  feeds: RssFeed[];
}

export interface CreateRssFeedInput {
  url: string;
  /** Up to 60 characters. */
  label?: string;
}

export interface Deleted {
  deleted: boolean;
}

export interface Revoked {
  revoked: boolean;
}

// ---- Webhook deliveries you receive (see verifyWebhookSignature)

export type WebhookEventName = "post.verified" | "post.failed" | "post.unconfirmed" | "channel.needs_reconnect" | "webhook.test";

/** The JSON body LazyRelay POSTs to your endpoint. Event-specific fields sit next to these three. */
export interface WebhookPayload {
  event: WebhookEventName;
  /** Stable across retries: use it to ignore a repeat. Also sent as the X-LazyRelay-Delivery header. */
  eventId: string;
  createdAt: string;
  [field: string]: unknown;
}
