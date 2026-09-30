# n8n-nodes-lazyrelay

n8n community nodes for [LazyRelay](https://lazyrelay.com), the social post scheduler. Schedule and publish posts, save drafts, upload media, read analytics, hand clients a review link, and start workflows from signed LazyRelay webhooks.

Status: built and unit tested, **not yet tested inside a live n8n instance** (see "What has and has not been verified" at the bottom).

## Install

In n8n, open **Settings > Community Nodes > Install**, enter `n8n-nodes-lazyrelay`, accept the community node notice and install. (Self-hosted n8n only, until the package is verified for n8n Cloud.)

## Credentials

Create a **LazyRelay API** credential:

| Field | What to enter |
| --- | --- |
| API Key | An API key from the LazyRelay dashboard (starts with `lzr_live_`). Stored as a password field and sent as `Authorization: Bearer ...`. |
| Base URL | Leave the default (`https://lazyrelaylazyrelay-backend.onrender.com/api`) unless LazyRelay tells you otherwise. |

The credential test calls `GET /social-accounts`.

## LazyRelay node

Every operation returns the API response as JSON and keeps item pairing. "Get Many" operations return one item per result. Enable **Continue On Fail** to get an `{ "error": "..." }` item instead of stopping the workflow. Errors carry the API's own message text.

| Resource | Operation | API call |
| --- | --- | --- |
| Post | Schedule | `POST /scheduled-posts` |
| Post | Publish Now | `POST /scheduled-posts` (scheduled for the current time; the scheduler publishes within moments, so check `verified_live` afterwards) |
| Post | Create Draft | `POST /scheduled-posts/draft` |
| Post | Schedule Draft | `PATCH /scheduled-posts/:id/schedule` |
| Post | Get Many | `GET /scheduled-posts` (filters: status, account, brand, limit) |
| Post | Update | `PATCH /scheduled-posts/:id` |
| Post | Delete | `DELETE /scheduled-posts/:id` |
| Post | Approve | `PATCH /scheduled-posts/:id/approve` |
| Post | Get Proof Link | `GET /scheduled-posts/:id/proof-link` (the API key must be allowed to share proof) |
| Account | Get Many | `GET /social-accounts` |
| Platform Rules | Get | `GET /platforms/rules` (optional platform) |
| Media | Upload | `POST /media/upload` (multipart field `file`, from a binary property; returns `id` and `url`) |
| Posting Slot | Get Next Free Slot | `GET /posting-slots/next` |
| Analytics | Get Summary | `GET /analytics/summary` (days, brand, tag) |
| Client Review Link | Create | `POST /review-links` (also returns the public `url`) |
| Client Review Link | Get Many | `GET /review-links` |
| Client Review Link | Revoke | `DELETE /review-links/:id` |

### Post fields

Schedule, Publish Now, Create Draft and Schedule Draft show the common fields directly: **Account** (a list loaded from your connected accounts, shown as platform and name), **Text**, **Scheduled For**, **Media URL** and **Requires Approval**. Everything else lives in **Additional Fields**:

extra image URLs, tags, first comment, self-reply text and like threshold, cover image URL, alt text, Pinterest board ID and destination link, TikTok privacy level, comment, duet and stitch switches, TikTok brand flags, and a **Platform Options (JSON)** object for settings such as `{"youtube":{"title":"My video","privacy":"public"}}` or `{"instagram":{"placement":"reel"}}`. Use the Platform Rules operation to see what each platform accepts.

TikTok posts need a privacy level. Pinterest posts need a board ID.

Scheduled For is converted to an ISO 8601 UTC time before it is sent. A value without a time zone is read in the time zone of the machine running n8n.

To attach a file you have in the workflow: use **Media > Upload** first, then pass its `url` as the Media URL of the post.

## LazyRelay Trigger node

Starts a workflow when LazyRelay sends a webhook: `post.verified`, `post.failed`, `post.unconfirmed` or `channel.needs_reconnect`.

LazyRelay only lets a signed-in person create webhook endpoints, not an API key (a leaked key must not be able to repoint your webhooks). So the trigger does not register itself. Setup is two steps:

1. Add the **LazyRelay Trigger** node. Copy its **Production URL** (use the Test URL while building). In LazyRelay go to **Settings > Webhooks**, add an endpoint with that URL, choose events, and copy the secret LazyRelay shows you (it is shown once).
2. Paste that secret into the trigger's **Webhook Secret** field, then activate the workflow.

What the trigger does with each delivery:

- Verifies the `X-LazyRelay-Signature` header (HMAC-SHA256 of the raw request body, hex, keyed with your secret) using a timing-safe comparison. A wrong or missing signature gets a `401` and does not start the workflow.
- Answers `webhook.test` events (from the Send test button in LazyRelay) with `200` and does not start the workflow.
- Applies the **Events** filter: events you did not select are answered with `200` and ignored. Clear the list to accept every event.
- Passes the parsed payload out as the item JSON, for example `{ "event": "post.failed", "eventId": "...", "createdAt": "...", "postId": "...", "platform": "...", "socialAccountId": "...", "content": "...", "reason": "..." }`.

The secret is stored in the workflow (n8n hides it in the editor, but it is included when you export the workflow), so do not share exported workflows that contain it. If you regenerate the secret in LazyRelay, paste the new one here.

### Example: alert Slack when a post fails

1. **LazyRelay Trigger** with Events set to Post Failed.
2. **Slack** node: message `Post {{ $json.postId }} on {{ $json.platform }} failed: {{ $json.reason }}`.

### Example: schedule from a spreadsheet row

1. **Google Sheets** trigger for new rows.
2. **LazyRelay** node: Post > Schedule. Pick the account, set Text to `{{ $json.caption }}` and Scheduled For to `{{ $json.publish_at }}`.

## Development

```
npm install
npm run build   # tsc, then copies the SVG icons into dist
npm test        # vitest
npm run lint    # @n8n/eslint-plugin-community-nodes
```

Tests mock n8n's `IExecuteFunctions` and `IWebhookFunctions`, and assert the exact method, URL, query and body for every operation.

## What has and has not been verified

- Unit tests cover every operation's request, the Additional Fields mapping, error handling, Continue On Fail, multipart upload, signature verification and event filtering.
- The lint config from n8n's community node linter passes.
- The LazyRelay node was run end to end in a real self-hosted n8n (version 2.41.4) against the live LazyRelay API: listing accounts, reading platform rules, listing posts and uploading a file (multipart, built by hand as a Buffer because n8n only recognises the `form-data` package, which a community node cannot depend on) all worked.
- The trigger node (webhooks) has been tested with mocks only, not yet in a live n8n.

## License

MIT
