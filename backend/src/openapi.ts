// LazyRelay's REST API as an OpenAPI 3.1 document (master list #25/#26). Served at GET /api/openapi.json
// and usable by Make, n8n's HTTP node, Zapier, ChatGPT actions, Postman, code generators and anything else
// that reads OpenAPI. It describes ONLY what an API key can reach: routes that need a signed-in person
// (API keys, team, billing, webhook management, DM automations) are deliberately left out, and a test proves
// every path here exists on the real app, so the document cannot invent an endpoint.

type Json = Record<string, unknown>;

const PLATFORM_LIST = "instagram, facebook, tiktok, youtube, pinterest, linkedin, threads, bluesky, mastodon, x, tumblr, telegram, discord, wordpress, devto, hashnode, lemmy, slack, nostr, whop";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (schema: Json, required = true) => ({ required, content: { "application/json": { schema } } });
const okJson = (description: string, schema: Json = { type: "object", additionalProperties: true }) => ({ description, content: { "application/json": { schema } } });
const errorResponses = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((c) => [
      String(c),
      {
        description:
          { 400: "The request was refused: the message says what to fix.", 401: "Missing or invalid API key.", 403: "Not allowed: a plan limit, or this key may not do that.", 404: "Not found, or not yours.", 409: "Conflict: for example the post is no longer in a state that allows this.", 429: "Too many requests." }[c] ?? "Error",
        content: { "application/json": { schema: ref("Error") } },
      },
    ]),
  );
const pathId = (name = "id", description = "The id") => ({ name, in: "path", required: true, description, schema: { type: "string" } });

interface OpArgs {
  tag: string;
  summary: string;
  description?: string;
  parameters?: Json[];
  body?: Json;
  ok?: Json;
  errors?: number[];
  publicRoute?: boolean;
}
function op(id: string, a: OpArgs): Json {
  return {
    operationId: id,
    tags: [a.tag],
    summary: a.summary,
    ...(a.description ? { description: a.description } : {}),
    ...(a.parameters ? { parameters: a.parameters } : {}),
    ...(a.body ? { requestBody: a.body } : {}),
    ...(a.publicRoute ? { security: [] } : {}),
    responses: { "200": a.ok ?? okJson("OK"), ...errorResponses(...(a.errors ?? [400, 401, 404]), 429) },
  };
}

const postFields: Json = {
  mediaUrl: { type: "string", format: "uri", description: "A publicly accessible image or video URL. Upload a file first with POST /media/upload to get one." },
  mediaUrls: { type: "array", items: { type: "string", format: "uri" }, description: "Extra images after mediaUrl (multi-image post). GET /platforms/rules says how many each platform takes." },
  coverImageUrl: { type: "string", format: "uri", description: "A still cover for a video (Pinterest video pins need one)." },
  mediaAltText: { type: "string", description: "Accessibility description of the main image." },
  firstComment: { type: "string", description: "Posted right after publishing (Facebook and Instagram)." },
  firstCommentDelayMinutes: { type: "integer", minimum: 0, maximum: 1440, description: "Minutes to wait after the post goes live before posting firstComment (Facebook and Instagram). 0 or omitted posts it right away. Needs firstComment." },
  tags: { type: "array", items: { type: "string" }, maxItems: 5, description: "Up to 5 short labels; filter analytics by them." },
  selfReplyText: { type: "string", description: "A comment added once the post reaches selfReplyAtLikes likes (Facebook and Instagram)." },
  selfReplyAtLikes: { type: "integer", minimum: 1 },
  boardId: { type: "string", description: "Pinterest: the board to pin to (GET /social-accounts/{id}/boards)." },
  destinationLink: { type: "string", format: "uri", description: "Pinterest: where a click on the pin goes." },
  tiktokPrivacyLevel: { type: "string", enum: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"], description: "TikTok: REQUIRED for TikTok. GET /social-accounts/{id}/tiktok-creator-info lists what the account allows." },
  tiktokDisableComment: { type: "boolean", description: "TikTok: comments off (default true)." },
  tiktokDisableDuet: { type: "boolean", description: "TikTok: duets off (default true)." },
  tiktokDisableStitch: { type: "boolean", description: "TikTok: stitches off (default true)." },
  tiktokBrandOrganic: { type: "boolean" },
  tiktokBrandContent: { type: "boolean" },
  options: ref("PostOptions"),
};

const schemas: Json = {
  Error: { type: "object", required: ["error"], properties: { error: { type: "string", description: "A plain-language reason." } } },
  PostOptions: {
    type: "object",
    description: "Platform-specific settings. Send only the key that belongs to the account's platform; another platform's key is refused.",
    properties: {
      tiktok: { type: "object", properties: { aiGenerated: { type: "boolean" } } },
      youtube: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 100 },
          privacy: { type: "string", enum: ["public", "unlisted", "private"] },
          madeForKids: { type: "boolean" },
          tags: { type: "array", items: { type: "string" }, maxItems: 15 },
          aiGenerated: { type: "boolean" },
        },
      },
      instagram: {
        type: "object",
        properties: {
          placement: { type: "string", enum: ["feed", "reel", "story"] },
          trialReel: { type: "boolean" },
          trialGraduation: { type: "string", enum: ["manual", "auto"] },
        },
      },
      facebook: { type: "object", properties: { placement: { type: "string", enum: ["feed", "story"] } } },
      linkedin: { type: "object", properties: { documentUrl: { type: "string", format: "uri", description: "https address of a PDF" }, documentTitle: { type: "string", maxLength: 100 } } },
      chain: { type: "array", items: { type: "string" }, maxItems: 10, description: "Threads, Bluesky, Mastodon and X: follow-up posts that reply in order (a thread)." },
    },
  },
  PostInput: {
    type: "object",
    required: ["socialAccountId", "content", "scheduledFor"],
    properties: {
      socialAccountId: { type: "string", description: "From GET /social-accounts." },
      content: { type: "string", description: "The post text." },
      scheduledFor: { type: "string", format: "date-time", description: "ISO 8601, in the future (the current time posts right away)." },
      requiresApproval: { type: "boolean", description: "Hold the post until it is approved (dashboard, PATCH /scheduled-posts/{id}/approve, or a client review link)." },
      ...postFields,
    },
  },
  DraftInput: { type: "object", required: ["content"], properties: { content: { type: "string" }, plannedDate: { type: "string", format: "date" }, plannedAccountIds: { type: "array", items: { type: "string" } }, scheduledFor: { type: "string", format: "date-time" }, ...postFields } },
  ScheduleDraftInput: {
    type: "object",
    required: ["socialAccountId", "content", "scheduledFor"],
    properties: { socialAccountId: { type: "string" }, content: { type: "string" }, scheduledFor: { type: "string", format: "date-time" }, requiresApproval: { type: "boolean" }, ...postFields },
  },
  PostEditInput: { type: "object", description: "Only what you send changes.", properties: { content: { type: "string" }, plannedDate: { type: "string", format: "date" }, ...postFields } },
  Post: {
    type: "object",
    additionalProperties: true,
    properties: {
      id: { type: "string" },
      status: { type: "string", enum: ["draft", "needs_approval", "pending", "posting", "posted", "failed"] },
      social_account_id: { type: ["string", "null"] },
      content: { type: "string" },
      scheduled_for: { type: ["string", "null"], format: "date-time" },
      media_url: { type: ["string", "null"] },
      media_urls: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
      options: ref("PostOptions"),
      changes_requested_at: { type: ["string", "null"], format: "date-time" },
      post_results: {
        type: "array",
        description: "Newest attempt first. verified_live is Proof-of-Publish: the platform was asked and confirmed the post is live.",
        items: { type: "object", additionalProperties: true, properties: { verified_live: { type: "boolean" }, platform_post_url: { type: ["string", "null"] }, error_message: { type: ["string", "null"] }, chain_posted: { type: ["integer", "null"] } } },
      },
    },
  },
  SocialAccount: {
    type: "object",
    additionalProperties: true,
    properties: {
      id: { type: "string" },
      platform: { type: "string", description: PLATFORM_LIST },
      display_name: { type: ["string", "null"] },
      connected_at: { type: "string", format: "date-time" },
      disconnected_at: { type: ["string", "null"], format: "date-time" },
      needs_reconnect_at: { type: ["string", "null"], format: "date-time", description: "Set when the platform login needs the owner to reconnect it." },
      brand_label: { type: ["string", "null"] },
    },
  },
  ReviewLink: {
    type: "object",
    properties: { id: { type: "string" }, token: { type: "string" }, label: { type: ["string", "null"] }, brandLabel: { type: ["string", "null"] }, expiresAt: { type: "string", format: "date-time" }, lastViewedAt: { type: ["string", "null"] }, createdAt: { type: "string" }, status: { type: "string", enum: ["active", "expired", "revoked"] } },
  },
  ReviewComment: { type: "object", properties: { id: { type: "string" }, authorKind: { type: "string", enum: ["reviewer", "owner"] }, authorName: { type: "string" }, kind: { type: "string", enum: ["comment", "approved", "changes_requested", "updated"] }, body: { type: ["string", "null"] }, createdAt: { type: "string", format: "date-time" } } },
  PostingSlot: { type: "object", properties: { id: { type: "string" }, daysOfWeek: { type: "array", items: { type: "integer", minimum: 1, maximum: 7 }, description: "ISO weekday, 1 Monday to 7 Sunday." }, timeOfDay: { type: "string", example: "09:00" }, timezone: { type: "string", example: "Africa/Johannesburg" } } },
  Snippet: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, content: { type: "string" }, isSignature: { type: "boolean" } } },
  RssFeed: { type: "object", properties: { id: { type: "string" }, url: { type: "string" }, label: { type: ["string", "null"] }, enabled: { type: "boolean" }, lastCheckedAt: { type: ["string", "null"] }, lastError: { type: ["string", "null"] } } },
  MediaItem: { type: "object", additionalProperties: true, properties: { id: { type: "string" }, url: { type: "string" }, mime_type: { type: "string" }, size_bytes: { type: "integer" }, alt_text: { type: ["string", "null"] } } },
  PlatformRules: {
    type: "object",
    properties: { platforms: { type: "array", items: { type: "object", additionalProperties: true, description: "text limit, media rules, required fields, features, options, limits, lookups, notes and sources for one platform" } } },
  },
};

function paths(): Json {
  const idParam = [pathId("id", "The post id")];
  return {
    "/social-accounts": { get: op("listSocialAccounts", { tag: "Accounts", summary: "List connected social accounts", ok: okJson("The connected accounts.", { type: "array", items: ref("SocialAccount") }), errors: [401] }) },
    "/social-accounts/{id}/boards": { get: op("listPinterestBoards", { tag: "Accounts", summary: "List a Pinterest account's boards", parameters: [pathId("id", "A Pinterest account id")], errors: [401, 403, 404] }) },
    "/social-accounts/{id}/tiktok-creator-info": { get: op("getTikTokCreatorInfo", { tag: "Accounts", summary: "What a TikTok account allows (privacy levels, interactions, longest video)", parameters: [pathId("id", "A TikTok account id")], errors: [401, 403, 404] }) },
    "/platforms": { get: op("listPlatforms", { tag: "Platforms", summary: "Every supported platform and whether it is available", errors: [401] }) },
    "/platforms/rules": {
      get: op("getPlatformRules", {
        tag: "Platforms",
        summary: "What each platform accepts, before you post",
        description: "Text limit, image and video rules, how many images per post, required fields (for example TikTok's privacy level and Pinterest's board), features and the options each platform reads.",
        parameters: [{ name: "platform", in: "query", required: false, description: PLATFORM_LIST, schema: { type: "string" } }],
        ok: okJson("One entry per platform.", ref("PlatformRules")),
        errors: [401, 404],
      }),
    },

    "/scheduled-posts": {
      get: op("listScheduledPosts", { tag: "Posts", summary: "List upcoming posts and the most recent finished ones", ok: okJson("Posts, with post_results (Proof-of-Publish).", { type: "array", items: ref("Post") }), errors: [401] }),
      post: op("schedulePost", {
        tag: "Posts",
        summary: "Schedule a post to one connected account",
        description: "Call once per account to post to several. Checks the platform's rules now, so an error says what to fix. Poll GET /scheduled-posts and read post_results[0].verified_live to confirm it really went live.",
        body: jsonBody(ref("PostInput")),
        ok: okJson("The created post.", ref("Post")),
        errors: [400, 401, 403, 404],
      }),
    },
    "/scheduled-posts/history": { get: op("listPostHistory", { tag: "Posts", summary: "Older finished posts, a page at a time", parameters: [{ name: "before", in: "query", required: false, description: "ISO time: only posts older than this", schema: { type: "string", format: "date-time" } }, { name: "limit", in: "query", required: false, schema: { type: "integer", maximum: 100 } }], ok: okJson("Posts.", { type: "array", items: ref("Post") }), errors: [401] }) },
    "/scheduled-posts/bulk": { post: op("bulkSchedulePosts", { tag: "Posts", summary: "Schedule up to 200 posts in one call", description: "Each row is checked like a single post; one bad row does not stop the others.", body: jsonBody({ type: "object", required: ["posts"], properties: { posts: { type: "array", maxItems: 200, items: ref("PostInput") } } }), errors: [400, 401] }) },
    "/scheduled-posts/draft": { post: op("createDraft", { tag: "Drafts", summary: "Save a draft with no account or time yet", body: jsonBody(ref("DraftInput")), ok: okJson("The draft.", ref("Post")), errors: [400, 401, 403] }) },
    "/scheduled-posts/{id}": {
      patch: op("editPost", { tag: "Posts", summary: "Edit a draft, a post waiting for approval, or a pending post", parameters: idParam, body: jsonBody(ref("PostEditInput")), ok: okJson("The post.", ref("Post")), errors: [400, 401, 404, 409] }),
      delete: op("deletePost", { tag: "Posts", summary: "Cancel a pending or waiting post, or clear a finished one", parameters: idParam, ok: okJson("Deleted."), errors: [401, 404, 409] }),
    },
    "/scheduled-posts/{id}/schedule": { patch: op("scheduleDraft", { tag: "Drafts", summary: "Turn a draft into a scheduled post", parameters: idParam, body: jsonBody(ref("ScheduleDraftInput")), ok: okJson("The post.", ref("Post")), errors: [400, 401, 403, 404, 409] }) },
    "/scheduled-posts/{id}/approve": { patch: op("approvePost", { tag: "Posts", summary: "Approve a post that is waiting for approval", parameters: idParam, ok: okJson("The post, now pending.", ref("Post")), errors: [401, 404] }) },
    "/scheduled-posts/{id}/pause": { patch: op("pausePost", { tag: "Posts", summary: "Pause a pending post", parameters: idParam, errors: [401, 404, 409] }) },
    "/scheduled-posts/{id}/resume": { patch: op("resumePost", { tag: "Posts", summary: "Resume a paused post", parameters: idParam, errors: [401, 404, 409] }) },
    "/scheduled-posts/{id}/reschedule": { patch: op("reschedulePost", { tag: "Posts", summary: "Move a pending post to a new time (the current time posts right away)", parameters: idParam, body: jsonBody({ type: "object", required: ["scheduledFor"], properties: { scheduledFor: { type: "string", format: "date-time" } } }), ok: okJson("The post.", ref("Post")), errors: [400, 401, 404, 409] }) },
    "/scheduled-posts/{id}/duplicate": { post: op("duplicatePost", { tag: "Posts", summary: "Copy a post to a new time", parameters: idParam, body: jsonBody({ type: "object", required: ["scheduledFor"], properties: { scheduledFor: { type: "string", format: "date-time" }, requiresApproval: { type: "boolean" } } }), ok: okJson("The new post.", ref("Post")), errors: [400, 401, 403, 404] }) },
    "/scheduled-posts/{id}/proof-link": { get: op("getProofLink", { tag: "Posts", summary: "A public proof-of-publish link for a post confirmed live", description: "The API key must be allowed to share proof (a per-key setting in the dashboard).", parameters: idParam, errors: [401, 403, 404] }) },
    "/scheduled-posts/{id}/review-comments": {
      get: op("listReviewComments", { tag: "Client review", summary: "The client conversation on a post", parameters: idParam, ok: okJson("Comments.", { type: "object", properties: { comments: { type: "array", items: ref("ReviewComment") } } }), errors: [401, 404] }),
      post: op("addReviewComment", { tag: "Client review", summary: "Reply in the client conversation", parameters: idParam, body: jsonBody({ type: "object", required: ["body"], properties: { body: { type: "string", maxLength: 1000 } } }), ok: okJson("The comment.", ref("ReviewComment")), errors: [400, 401, 404] }),
    },

    "/review-links": {
      get: op("listReviewLinks", { tag: "Client review", summary: "Client review links and how many the plan allows", ok: okJson("Links.", { type: "object", properties: { maxLinks: { type: "integer" }, links: { type: "array", items: ref("ReviewLink") } } }), errors: [401] }),
      post: op("createReviewLink", { tag: "Client review", summary: "Create a link a client opens, with no account, to approve posts and comment", description: "The client opens https://lazyrelay.com/review/{token}. Needs a plan that includes review links.", body: jsonBody({ type: "object", properties: { label: { type: "string" }, brandLabel: { type: "string" }, expiresInDays: { type: "integer", minimum: 1, maximum: 90 } } }, false), ok: okJson("The link.", ref("ReviewLink")), errors: [400, 401, 403] }),
    },
    "/review-links/{id}": { delete: op("revokeReviewLink", { tag: "Client review", summary: "Stop a review link working at once", parameters: [pathId("id", "The link id")], errors: [401, 404] }) },

    "/media": { get: op("listMedia", { tag: "Media", summary: "Uploaded files", ok: okJson("Files.", { type: "array", items: ref("MediaItem") }), errors: [401] }) },
    "/media/usage": { get: op("getMediaUsage", { tag: "Media", summary: "Storage used and the plan's limit", errors: [401] }) },
    "/media/upload": {
      post: op("uploadMedia", {
        tag: "Media",
        summary: "Upload an image, video or PDF and get a public URL to use in a post",
        body: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" }, altText: { type: "string", maxLength: 1000 } } } } } },
        ok: okJson("The file.", { type: "object", properties: { id: { type: "string" }, url: { type: "string" }, altText: { type: ["string", "null"] } } }),
        errors: [400, 401, 413],
      }),
    },
    "/media/{id}": {
      patch: op("editMediaAltText", { tag: "Media", summary: "Change a file's alt text", parameters: [pathId("id", "The file id")], body: jsonBody({ type: "object", properties: { altText: { type: ["string", "null"] } } }), errors: [400, 401, 404] }),
      delete: op("deleteMedia", { tag: "Media", summary: "Delete an uploaded file (refused while a pending post uses it)", parameters: [pathId("id", "The file id")], errors: [401, 404, 409] }),
    },

    "/posting-slots": {
      get: op("listPostingSlots", { tag: "Scheduling", summary: "Saved posting times", ok: okJson("Slots.", { type: "object", properties: { maxSlots: { type: "integer" }, slots: { type: "array", items: ref("PostingSlot") } } }), errors: [401] }),
      post: op("createPostingSlot", { tag: "Scheduling", summary: "Save a posting time", body: jsonBody({ type: "object", required: ["daysOfWeek", "timeOfDay", "timezone"], properties: { daysOfWeek: { type: "array", items: { type: "integer", minimum: 1, maximum: 7 } }, timeOfDay: { type: "string", example: "09:00" }, timezone: { type: "string", example: "Africa/Johannesburg" } } }), ok: okJson("The slot.", ref("PostingSlot")), errors: [400, 401] }),
    },
    "/posting-slots/{id}": { delete: op("deletePostingSlot", { tag: "Scheduling", summary: "Remove a posting time", parameters: [pathId("id", "The slot id")], errors: [401, 404] }) },
    "/posting-slots/next": { get: op("getNextFreeSlot", { tag: "Scheduling", summary: "The next free posting time for an account, to use as scheduledFor", parameters: [{ name: "socialAccountId", in: "query", required: true, schema: { type: "string" } }], ok: okJson("A time.", { type: "object", properties: { scheduledFor: { type: "string", format: "date-time" } } }), errors: [400, 401, 404] }) },
    "/recurring-schedules": {
      get: op("listRecurringSchedules", { tag: "Scheduling", summary: "Weekly repeating posts", errors: [401] }),
      post: op("createRecurringSchedule", {
        tag: "Scheduling",
        summary: "Post the same thing on chosen weekdays, every week",
        description: "A paid-plan feature with a per-plan cap. Accepts the same post fields as a single post.",
        body: jsonBody({ type: "object", required: ["content", "socialAccountIds", "daysOfWeek", "timeOfDay", "timezone"], properties: { content: { type: "string" }, socialAccountIds: { type: "array", items: { type: "string" } }, daysOfWeek: { type: "array", items: { type: "integer", minimum: 1, maximum: 7 } }, timeOfDay: { type: "string", example: "09:00" }, timezone: { type: "string" }, startsOn: { type: "string", format: "date" }, endsOn: { type: ["string", "null"], format: "date" }, ...postFields } }),
        errors: [400, 401, 403],
      }),
    },
    "/recurring-schedules/{id}": {
      patch: op("editRecurringSchedule", { tag: "Scheduling", summary: "Edit, pause or resume a weekly schedule", parameters: [pathId("id", "The schedule id")], body: jsonBody({ type: "object", additionalProperties: true, properties: { status: { type: "string", enum: ["active", "paused"] } } }), errors: [400, 401, 404] }),
      delete: op("deleteRecurringSchedule", { tag: "Scheduling", summary: "Delete a weekly schedule", parameters: [pathId("id", "The schedule id")], errors: [401, 404] }),
    },

    "/snippets": {
      get: op("listSnippets", { tag: "Content", summary: "Saved text snippets and the signature", ok: okJson("Snippets.", { type: "object", properties: { maxSnippets: { type: "integer" }, snippets: { type: "array", items: ref("Snippet") } } }), errors: [401] }),
      post: op("createSnippet", { tag: "Content", summary: "Save a snippet", body: jsonBody({ type: "object", required: ["name", "content"], properties: { name: { type: "string", maxLength: 60 }, content: { type: "string", maxLength: 2000 }, isSignature: { type: "boolean" } } }), ok: okJson("The snippet.", ref("Snippet")), errors: [400, 401] }),
    },
    "/snippets/{id}": {
      patch: op("editSnippet", { tag: "Content", summary: "Edit a snippet", parameters: [pathId("id", "The snippet id")], body: jsonBody({ type: "object", properties: { name: { type: "string" }, content: { type: "string" }, isSignature: { type: "boolean" } } }), errors: [400, 401, 404] }),
      delete: op("deleteSnippet", { tag: "Content", summary: "Delete a snippet", parameters: [pathId("id", "The snippet id")], errors: [401, 404] }),
    },
    "/rss-feeds": {
      get: op("listRssFeeds", { tag: "Content", summary: "RSS feeds whose new items become drafts", ok: okJson("Feeds.", { type: "object", properties: { maxFeeds: { type: "integer" }, feeds: { type: "array", items: ref("RssFeed") } } }), errors: [401] }),
      post: op("createRssFeed", { tag: "Content", summary: "Add a feed (new items become drafts, never posts)", description: "A paid-plan feature with a per-plan cap. The address is fetched and read first, so a non-feed is refused at once.", body: jsonBody({ type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" }, label: { type: "string" } } }), ok: okJson("The feed.", ref("RssFeed")), errors: [400, 401, 403] }),
    },
    "/rss-feeds/{id}": {
      patch: op("setRssFeedEnabled", { tag: "Content", summary: "Pause or resume a feed", parameters: [pathId("id", "The feed id")], body: jsonBody({ type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } }), errors: [400, 401, 404] }),
      delete: op("deleteRssFeed", { tag: "Content", summary: "Remove a feed", parameters: [pathId("id", "The feed id")], errors: [401, 404] }),
    },

    "/analytics/summary": {
      get: op("getAnalyticsSummary", {
        tag: "Analytics",
        summary: "Post counts, verified-live rate, per-platform breakdown and engagement",
        parameters: [
          { name: "days", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 90, default: 30 } },
          { name: "brand", in: "query", required: false, schema: { type: "string" } },
          { name: "tag", in: "query", required: false, description: "Only posts with this tag. availableTags in the answer lists the tags in use.", schema: { type: "string" } },
        ],
        errors: [401],
      }),
    },
    "/mentions": { get: op("listMentions", { tag: "Analytics", summary: "Recent comments on your posts, where the platform lets LazyRelay read them", errors: [401] }) },
    "/mentions/reply": { post: op("replyToMention", { tag: "Analytics", summary: "Reply to a comment from GET /mentions", body: jsonBody({ type: "object", required: ["postId", "commentId", "text"], properties: { postId: { type: "string" }, commentId: { type: "string" }, text: { type: "string" } } }), errors: [400, 401, 404] }) },
    "/brands": { get: op("listBrands", { tag: "Accounts", summary: "Brands (workspaces)", errors: [401] }) },

    "/public/verify/{id}": { get: op("getPublicProof", { tag: "Public", summary: "The public proof-of-publish page data (no key needed)", parameters: [pathId("id", "A post result id from a proof link")], publicRoute: true, errors: [404] }) },
    "/public/review/{token}": { get: op("getPublicReview", { tag: "Public", summary: "What a client sees through a review link (no key needed)", parameters: [pathId("token", "The review link token")], publicRoute: true, errors: [404] }) },
    "/public/review/{token}/posts/{postId}/approve": { post: op("publicReviewApprove", { tag: "Public", summary: "A client approves a post", parameters: [pathId("token"), pathId("postId")], body: jsonBody({ type: "object", required: ["name"], properties: { name: { type: "string", maxLength: 60 } } }), publicRoute: true, errors: [400, 404, 409] }) },
    "/public/review/{token}/posts/{postId}/changes": { post: op("publicReviewChanges", { tag: "Public", summary: "A client asks for changes", parameters: [pathId("token"), pathId("postId")], body: jsonBody({ type: "object", required: ["name", "comment"], properties: { name: { type: "string" }, comment: { type: "string", maxLength: 1000 } } }), publicRoute: true, errors: [400, 404, 409] }) },
    "/public/review/{token}/posts/{postId}/comments": { post: op("publicReviewComment", { tag: "Public", summary: "A client comments on a post", parameters: [pathId("token"), pathId("postId")], body: jsonBody({ type: "object", required: ["name", "comment"], properties: { name: { type: "string" }, comment: { type: "string", maxLength: 1000 } } }), publicRoute: true, errors: [400, 404, 409] }) },
  };
}

export function buildOpenApiDocument(): Json {
  return {
    openapi: "3.1.0",
    info: {
      title: "LazyRelay API",
      version: "1.0.0",
      summary: "Schedule and publish social posts on every platform, with independent proof each one went live.",
      description:
        "Authenticate with an API key from the dashboard (the API Keys tab): send `Authorization: Bearer lzr_live_...`. This document lists what an API key can do. Managing API keys, team members, billing, webhooks and DM automations needs a person signed in to the dashboard and is not in the API. Webhook endpoints are created in the dashboard (Settings, Webhooks); see https://lazyrelay.com/docs for how to verify their signature.",
      contact: { name: "LazyRelay", url: "https://lazyrelay.com/contact" },
    },
    servers: [{ url: "https://lazyrelaylazyrelay-backend.onrender.com/api", description: "Production" }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Accounts", description: "Connected social accounts, brands, and per-platform lookups (Pinterest boards, TikTok settings)." },
      { name: "Platforms", description: "What each platform accepts, before you post." },
      { name: "Posts", description: "Schedule, publish, edit, approve and cancel posts, and read Proof-of-Publish." },
      { name: "Drafts", description: "Save a post without an account or time, then schedule it later." },
      { name: "Media", description: "Upload images, videos and PDFs to get a public URL for a post." },
      { name: "Scheduling", description: "Saved posting times, the next free slot, and weekly repeating posts." },
      { name: "Content", description: "Saved snippets and RSS feeds that turn new items into drafts." },
      { name: "Client review", description: "Links a client opens, with no account, to approve posts and comment, and the conversation on each post." },
      { name: "Analytics", description: "Results, engagement, and comments on your posts." },
      { name: "Public", description: "Endpoints that need no API key: proof pages and the client review page." },
    ],
    paths: paths(),
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "lzr_live_ API key", description: "An API key from the LazyRelay dashboard." } },
      schemas,
    },
  };
}
