# @lazyrelay/sdk

The official Node SDK and command-line tool for [LazyRelay](https://lazyrelay.com). Schedule and publish posts, upload media, read analytics and run client approvals from your own code or your terminal.

This package is a thin typed client over the LazyRelay REST API, which is documented at [https://lazyrelay.com/docs](https://lazyrelay.com/docs). It has no runtime dependencies and needs Node 18 or newer (it uses the built in `fetch`, `FormData`, `Blob` and `crypto`).

## Install

```sh
npm install @lazyrelay/sdk
```

To use the command line tool without adding it to a project:

```sh
npx @lazyrelay/sdk whoami
# or install it globally
npm install -g @lazyrelay/sdk
lazyrelay whoami
```

## Get an API key

Create a key in the LazyRelay dashboard under Settings, More, API Keys. Keys start with `lzr_live_`. Keep it secret: pass it through the `LAZYRELAY_API_KEY` environment variable rather than writing it into code or a command line.

## Quick start: SDK

```ts
import { LazyRelay } from "@lazyrelay/sdk";

// apiKey falls back to process.env.LAZYRELAY_API_KEY
const lr = new LazyRelay({ apiKey: process.env.LAZYRELAY_API_KEY });

// 1. Find the account to post to
const accounts = await lr.accounts.list();
const instagram = accounts.find((a) => a.platform === "instagram")!;

// 2. Check what the platform accepts (optional)
const { platforms } = await lr.rules.get("instagram");

// 3. Upload a local image, then schedule a post with it
const media = await lr.media.upload("./launch.png", { altText: "The launch banner" });
const post = await lr.posts.schedule({
  socialAccountId: instagram.id,
  content: "We just launched!",
  scheduledFor: new Date("2026-10-01T09:00:00Z"), // a Date or an ISO 8601 string
  mediaUrl: media.url,
  tags: ["launch"],
  options: { instagram: { placement: "feed" } },
});
console.log(post.id, post.status); // "pending"
```

A post goes to one account. To post to several, call `posts.schedule` once per account.

`posts.publishNow` queues a post for immediate publishing. The scheduler picks it up within moments, so it is not live when the call returns. List posts afterwards and check `post_results[0].verified_live`.

### Client options

```ts
new LazyRelay({
  apiKey: "lzr_live_...",   // default: process.env.LAZYRELAY_API_KEY
  baseUrl: "https://lazyrelaylazyrelay-backend.onrender.com/api", // default
  fetch: customFetch,       // default: the global fetch
  timeoutMs: 30000,         // default: 30000 (uploads default to 10 minutes)
});
```

## Quick start: command line

```sh
export LAZYRELAY_API_KEY=lzr_live_...

lazyrelay whoami
lazyrelay accounts
lazyrelay rules instagram
lazyrelay posts schedule --account <id> --text "We just launched!" --at 2026-10-01T09:00:00Z --media ./launch.png --tag launch
lazyrelay posts list --status pending
lazyrelay analytics --days 7
```

Every command prints a readable table or line by default and the raw JSON response with `--json`. The key comes from `--key` or `LAZYRELAY_API_KEY`. The tool never writes a config file and never prints your key. Errors print the plain message and a hint to standard error (in the CLI the hint names the command to run, such as `lazyrelay tiktok <accountId>`; the SDK's own hints name SDK methods) and exit with code 1. Success exits with 0. Run `lazyrelay help` or `lazyrelay <command> --help` for details.

A local file given to `--media` is uploaded first and its URL is used. Give `--media` more than once for a multi image post.

## Command line reference

| Command | What it does |
| --- | --- |
| `lazyrelay whoami` | Checks the key and prints how many accounts are connected and on which platforms |
| `lazyrelay accounts` | Lists connected accounts |
| `lazyrelay rules [platform]` | Shows what a platform accepts |
| `lazyrelay posts list [--status s] [--account id] [--limit n]` | Lists posts |
| `lazyrelay posts schedule --account <id> --text "..." --at <ISO time> [--media <url or file>] [--tag a,b] [--privacy LEVEL] [--board id] [--link url] [--options '<json>'] [--approval]` | Schedules a post. Refuses a missing `--account`, `--text` or `--at` before contacting the API |
| `lazyrelay posts now --account <id> --text "..." [same options, no --at]` | Queues a post for immediate publishing |
| `lazyrelay posts delete <id>` | Cancels or deletes a post |
| `lazyrelay posts approve <id>` | Approves a post that is waiting for approval |
| `lazyrelay posts reschedule <id> --at <ISO time>` | Moves a pending post to a new time |
| `lazyrelay posts pause <id>` / `lazyrelay posts resume <id>` | Holds or releases a pending post |
| `lazyrelay posts history [--limit n] [--before <ISO time>]` | Older posted and failed posts |
| `lazyrelay proof <id>` | Prints the public proof-of-publish link |
| `lazyrelay media upload <file> [--alt "..."]` | Uploads a file and prints its URL |
| `lazyrelay slots next <accountId>` | Prints the next free posting time for an account |
| `lazyrelay tiktok <accountId>` | Shows what a TikTok account allows: privacy levels, can post now, longest video |
| `lazyrelay boards <accountId>` | Lists a Pinterest account boards, for `--board` |
| `lazyrelay review create [--label x] [--days n] [--brand b]` | Creates a client review link and prints the client URL |
| `lazyrelay review list` | Lists client review links |
| `lazyrelay review revoke <id>` | Stops a client review link |
| `lazyrelay analytics [--days n] [--tag t] [--brand b]` | Post counts and engagement |
| `lazyrelay help` | Shows help |

Global options: `--key <key>`, `--json`, `--base-url <url>` (or `LAZYRELAY_BASE_URL`), `--help`.

## SDK reference

| Method | REST call | Notes |
| --- | --- | --- |
| `accounts.list()` | `GET /social-accounts` | Connected accounts and their ids |
| `brands.list()` | `GET /brands` | Brands (workspaces) |
| `rules.get(platform?)` | `GET /platforms/rules` | What a platform accepts: limits, media rules, required fields, options |
| `posts.schedule(input)` | `POST /scheduled-posts` | Schedule to one account. `requiresApproval: true` holds it for approval |
| `posts.publishNow(input)` | `POST /scheduled-posts` | Same, with the time set to now. Queued, not synchronous |
| `posts.list({ status, socialAccountId, limit, brand })` | `GET /scheduled-posts` | Upcoming posts plus the 50 most recent posted or failed ones. Filters are applied in the client |
| `posts.history({ limit, before })` | `GET /scheduled-posts/history` | Older posted and failed posts, one page at a time |
| `posts.update(id, input)` | `PATCH /scheduled-posts/:id` | Edit a draft, a post awaiting approval or a pending post |
| `posts.delete(id)` | `DELETE /scheduled-posts/:id` | Cancel or delete. Returns nothing (the API answers 204) |
| `posts.approve(id)` | `PATCH /scheduled-posts/:id/approve` | Approve a post that needs approval |
| `posts.proofLink(id)` | `GET /scheduled-posts/:id/proof-link` | Public proof link. The key must be allowed to share proof |
| `posts.duplicate(id, { scheduledFor })` | `POST /scheduled-posts/:id/duplicate` | Copy a post to a new time |
| `posts.createDraft(input)` | `POST /scheduled-posts/draft` | Save a draft with no account or time yet |
| `posts.scheduleDraft(id, input)` | `PATCH /scheduled-posts/:id/schedule` | Turn a draft into a scheduled post |
| `posts.reschedule(id, scheduledFor)` | `PATCH /scheduled-posts/:id/reschedule` | Move a pending post |
| `posts.pause(id)` / `posts.resume(id)` | `PATCH /scheduled-posts/:id/pause` and `/resume` | Hold or release a pending post |
| `media.upload(file, { altText })` | `POST /media/upload` | Multipart upload. `file` is a Blob or File, a Buffer or Uint8Array (with `filename`), or a local path. Returns `{ id, url, altText }` |
| `slots.list()` | `GET /posting-slots` | Saved posting times |
| `slots.next(socialAccountId)` | `GET /posting-slots/next` | Next free time for an account |
| `snippets.list()` | `GET /snippets` | Saved text snippets |
| `tiktok.creatorInfo(accountId)` | `GET /social-accounts/:id/tiktok-creator-info` | Allowed privacy levels and whether the account can post now |
| `pinterest.boards(accountId)` | `GET /social-accounts/:id/boards` | Boards, for `boardId` |
| `analytics.summary({ days, brand, tag })` | `GET /analytics/summary` | Counts, verified live rate, per platform engagement |
| `mentions.list()` | `GET /mentions` | Recent comments on your posts |
| `reviewLinks.list()` | `GET /review-links` | Client review links |
| `reviewLinks.create({ label, brandLabel, expiresInDays })` | `POST /review-links` | Returns the link plus `url`, the address to send a client |
| `reviewLinks.revoke(id)` | `DELETE /review-links/:id` | Stop a link working |
| `feedback.list(postId)` | `GET /scheduled-posts/:id/review-comments` | The client conversation on a post |
| `feedback.reply(postId, body)` | `POST /scheduled-posts/:id/review-comments` | Reply to the client, up to 1000 characters |
| `rssFeeds.list()` | `GET /rss-feeds` | Feeds whose new items become drafts |
| `rssFeeds.create({ url, label })` | `POST /rss-feeds` | Add a feed (paid plans) |
| `rssFeeds.setEnabled(id, enabled)` | `PATCH /rss-feeds/:id` | Pause or resume a feed |
| `rssFeeds.delete(id)` | `DELETE /rss-feeds/:id` | Remove a feed |
| `verifyWebhookSignature({ secret, rawBody, signature })` | none (runs locally) | Checks a webhook you received. See below |

All request and response types are exported (`SchedulePostInput`, `ScheduledPost`, `PostOptions`, `AnalyticsSummary` and so on). Response objects are returned exactly as the API sends them, so post rows use snake_case field names such as `scheduled_for` and `post_results`.

## Error handling

Every failure throws a `LazyRelayError`:

```ts
import { LazyRelay, LazyRelayError } from "@lazyrelay/sdk";

try {
  await lr.posts.schedule({ socialAccountId: "...", content: "Hi", scheduledFor: "2026-10-01T09:00:00Z" });
} catch (err) {
  if (err instanceof LazyRelayError) {
    console.error(err.status);    // HTTP status, or 0 if there was no response
    console.error(err.kind);      // validation | plan_limit | auth | permission | not_found | conflict | rate_limited | server | unknown
    console.error(err.message);   // the API's own error text
    console.error(err.hint);      // what to do next, or null
    console.error(err.retryable); // true for rate_limited and server errors
    console.error(err.body);      // the parsed error body, for extra fields such as nextAvailable
  }
}
```

Retries:

- An idempotent `GET` is retried once on a 5xx, a 429 (waiting for `Retry-After`, up to 10 seconds) or a network failure.
- HTTP 413 (storage quota) maps to kind `plan_limit`.
- `POST`, `PATCH` and `DELETE` are never retried automatically. A retried post could be created twice. If a write fails with `retryable: true`, decide yourself whether it is safe to try again, for example by listing posts first.

The API key is never included in an error.

## Webhook verification

LazyRelay can call your server when a post is confirmed live, fails, is sent but not confirmed, or an account needs reconnecting. Webhook endpoints are created by a person in the LazyRelay dashboard under Settings, Webhooks. The dashboard shows the signing secret once, when the endpoint is created (or when the secret is regenerated). Webhook endpoints cannot be managed with an API key, so this SDK has no methods for creating them. It does give you the receiving side.

Each delivery is a `POST` with a JSON body and these headers: `X-LazyRelay-Signature` (HMAC-SHA256 of the raw body, hex), `X-LazyRelay-Event`, `X-LazyRelay-Delivery` (stable across retries, use it to ignore repeats) and `X-LazyRelay-Attempt`.

```ts
import express from "express";
import { verifyWebhookSignature, type WebhookPayload } from "@lazyrelay/sdk";

const app = express();

// Keep the raw body: verify the exact bytes that were signed, not re-serialised JSON.
app.post("/lazyrelay-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const ok = verifyWebhookSignature({
    secret: process.env.LAZYRELAY_WEBHOOK_SECRET!,
    rawBody: req.body, // a Buffer
    signature: req.header("X-LazyRelay-Signature"),
  });
  if (!ok) return res.status(401).send("bad signature");

  const event: WebhookPayload = JSON.parse(req.body.toString("utf8"));
  console.log(event.event, event.eventId);
  res.sendStatus(200); // any 2xx counts as delivered
});
```

`verifyWebhookSignature` compares in constant time and returns `false` (it does not throw) for a missing, malformed or wrong signature.

## Notes

- `posts.list` returns upcoming posts and the 50 most recent posted or failed posts, because that is what the API returns. Use `posts.history` to page further back.
- Times are ISO 8601. Send a `Date` or a string; the SDK sends an ISO string.
- The command line tool accepts `LAZYRELAY_API_BASE` as a fallback for the API address, the same variable the LazyRelay MCP server reads.

## Development

```sh
npm install
npm run build   # tsc to dist/
npm test        # builds first, then runs the vitest suite against a local fake API server
```
