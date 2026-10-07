# LazyRelay MCP integration

LazyRelay exposes 27 tools over the Model Context Protocol, so an AI agent or editor can schedule posts, check whether a post is really live, listen to the comments on your own posts and manage drafts on a LazyRelay account. This page lists every tool exactly as the server describes it, with its full input schema. It is generated from the server's own tool definitions, so it cannot drift from what an agent receives.

## Connect

There are two ways to connect. Both expose the same tools.

1. **Hosted server (sign in with your LazyRelay account).** Add a custom remote MCP connector in your client and point it at `https://lazyrelaylazyrelay-backend.onrender.com/mcp`. The client signs you in with OAuth. Nothing to install.
2. **Local server (API key).** Run the `@lazyrelay/mcp-server` package with an API key from the **API Keys** tab of the dashboard:

```json
{
  "mcpServers": {
    "lazyrelay": {
      "command": "npx",
      "args": [
        "-y",
        "@lazyrelay/mcp-server"
      ],
      "env": {
        "LAZYRELAY_API_KEY": "lzr_live_your_key_here"
      }
    }
  }
}
```

An API key acts as your account, so treat it like a password. It is shown once when you create it.

Setup guides for 15 AI agents and editors are at https://lazyrelay.com/mcp/. MCP and API-key access is included on every plan, including Free. The REST API behind the tools is documented at https://lazyrelay.com/docs/ and described in OpenAPI 3.1 at https://lazyrelaylazyrelay-backend.onrender.com/api/openapi.json.

## Where the server is listed

- **Glama, as a server:** https://glama.ai/mcp/servers/gosswerner1-max/lazyrelay (built from the public repository).
- **Glama, as a connector:** https://glama.ai/mcp/connectors/com.onrender.lazyrelaylazyrelay-backend/lazy-relay (the hosted server, OAuth sign-in, no API key).
- **Official MCP Registry:** `io.github.gosswerner1-max/lazyrelay-mcp-server`, package `@lazyrelay/mcp-server`. Look it up at https://registry.modelcontextprotocol.io/v0/servers?search=lazyrelay.

## How the tools behave

- Every tool is a thin call to LazyRelay's own REST API, so plan limits, validation and platform rules are enforced in one place, whichever way you connect.
- Each tool declares whether it is read-only, whether it is destructive, whether it is safe to repeat, and whether it reaches a live platform (MCP annotations). Clients can use these to decide what to confirm with you.
- A failed call returns `isError: true` with a JSON body of the form `{ "error": { "kind", "status", "message", "hint", "retryable" } }`. `kind` is one of: `validation`, `plan_limit`, `auth`, `permission`, `not_found`, `conflict`, `rate_limited`, `server`, `unknown`. `hint` says what to call or change next when LazyRelay knows, and `retryable` is true only for rate limits and server errors.

## The 27 tools

| Tool | Title | Behaviour |
|---|---|---|
| [`list_connected_accounts`](#list_connected_accounts) | List connected accounts | read-only, safe to repeat |
| [`list_workspaces`](#list_workspaces) | List brands | read-only, safe to repeat |
| [`get_platform_rules`](#get_platform_rules) | Look up a platform's rules | read-only, safe to repeat |
| [`get_tiktok_creator_info`](#get_tiktok_creator_info) | Check what a TikTok account allows | read-only, safe to repeat, reaches a live platform |
| [`list_pinterest_boards`](#list_pinterest_boards) | List a Pinterest account's boards | read-only, safe to repeat, reaches a live platform |
| [`get_next_free_slot`](#get_next_free_slot) | Find the next free posting time | read-only, safe to repeat |
| [`list_posting_slots`](#list_posting_slots) | List saved posting times | read-only, safe to repeat |
| [`list_snippets`](#list_snippets) | List saved snippets | read-only, safe to repeat |
| [`schedule_post`](#schedule_post) | Schedule a post | changes data, reaches a live platform |
| [`publish_post_now`](#publish_post_now) | Publish a post now | changes data, reaches a live platform |
| [`create_draft`](#create_draft) | Save a draft | changes data |
| [`schedule_draft`](#schedule_draft) | Schedule a saved draft | changes data, reaches a live platform |
| [`update_post`](#update_post) | Edit a post | changes data, safe to repeat |
| [`reschedule_post`](#reschedule_post) | Move a post to a new time | changes data, safe to repeat |
| [`pause_post`](#pause_post) | Pause a pending post | changes data, safe to repeat |
| [`resume_post`](#resume_post) | Resume a paused post | changes data, safe to repeat |
| [`list_scheduled_posts`](#list_scheduled_posts) | List posts | read-only, safe to repeat |
| [`delete_scheduled_post`](#delete_scheduled_post) | Cancel a post | changes data, destructive, safe to repeat |
| [`get_proof_link`](#get_proof_link) | Get a proof-of-publish link | read-only, safe to repeat |
| [`approve_post`](#approve_post) | Approve a waiting post | changes data, safe to repeat |
| [`create_review_link`](#create_review_link) | Create a client review link | changes data |
| [`list_review_links`](#list_review_links) | List client review links | read-only, safe to repeat |
| [`revoke_review_link`](#revoke_review_link) | Stop a client review link | changes data, destructive, safe to repeat |
| [`get_post_feedback`](#get_post_feedback) | Read client feedback on a post | read-only, safe to repeat |
| [`reply_to_post_feedback`](#reply_to_post_feedback) | Reply to client feedback | changes data |
| [`get_analytics_summary`](#get_analytics_summary) | Get analytics | read-only, safe to repeat |
| [`get_mentions`](#get_mentions) | Read recent comments | read-only, safe to repeat, reaches a live platform |

### list_connected_accounts

**Title:** List connected accounts

**Behaviour:** read-only, safe to repeat.

**Description, exactly as the server sends it:**

```text
List every social account connected to this LazyRelay account, with platform, display name and the id the posting tools need. Accounts that need reconnecting say so.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

### list_workspaces

**Title:** List brands

**Behaviour:** read-only, safe to repeat.

**Description, exactly as the server sends it:**

```text
List this account's brands (workspaces), with the id needed to file a post under a specific one.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

### get_platform_rules

**Title:** Look up a platform's rules

**Behaviour:** read-only, safe to repeat.

**Description, exactly as the server sends it:**

```text
What a platform accepts BEFORE you post: text limit, image and video rules, how many images per post, which fields are required (for example TikTok's privacy level, Pinterest's board), features (stories, threads, first comment) and the options it reads. Pass a platform such as instagram or tiktok, or leave it out for all of them.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "platform": {
      "description": "For example instagram, tiktok, pinterest, youtube. Leave out for all platforms",
      "type": "string"
    }
  },
  "additionalProperties": false
}
```

### get_tiktok_creator_info

**Title:** Check what a TikTok account allows

**Behaviour:** read-only, safe to repeat, reaches a live platform.

**Description, exactly as the server sends it:**

```text
For one connected TikTok account: the privacy levels it can use, whether comments, duets and stitches are allowed, and the longest video. Call this before posting to TikTok, because tiktokPrivacyLevel is required and must be one of the levels returned.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "socialAccountId": {
      "type": "string",
      "description": "A TikTok account id from list_connected_accounts"
    }
  },
  "required": [
    "socialAccountId"
  ],
  "additionalProperties": false
}
```

### list_pinterest_boards

**Title:** List a Pinterest account's boards

**Behaviour:** read-only, safe to repeat, reaches a live platform.

**Description, exactly as the server sends it:**

```text
For one connected Pinterest account: its boards with their ids. A Pinterest post needs a boardId from this list.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "socialAccountId": {
      "type": "string",
      "description": "A Pinterest account id from list_connected_accounts"
    }
  },
  "required": [
    "socialAccountId"
  ],
  "additionalProperties": false
}
```

### get_next_free_slot

**Title:** Find the next free posting time

**Behaviour:** read-only, safe to repeat.

**Description, exactly as the server sends it:**

```text
The account's next free posting time for one connected account, from the posting times saved in Settings. Returns an ISO timestamp to use as scheduledFor. Says so plainly if no posting times are saved.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "socialAccountId": {
      "type": "string",
      "description": "The connected account id, from list_connected_accounts"
    }
  },
  "required": [
    "socialAccountId"
  ],
  "additionalProperties": false
}
```

### list_posting_slots

**Title:** List saved posting times

**Behaviour:** read-only, safe to repeat.

**Description, exactly as the server sends it:**

```text
The posting times saved in Settings (days, time, time zone).
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

### list_snippets

**Title:** List saved snippets

**Behaviour:** read-only, safe to repeat.

**Description, exactly as the server sends it:**

```text
The account's saved text snippets (hashtag groups, sign-offs) and which one is the signature, to paste into a post.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

### schedule_post

**Title:** Schedule a post

**Behaviour:** changes data, reaches a live platform.

**Description, exactly as the server sends it:**

```text
Schedule a post to ONE connected account (call once per account to post to several). Use list_connected_accounts for the id and get_platform_rules to see what the platform needs. TikTok needs tiktokPrivacyLevel, Pinterest needs boardId. Set requiresApproval to hold it for a client to approve first.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "socialAccountId": {
      "type": "string",
      "description": "The connected account id to post to, from list_connected_accounts"
    },
    "content": {
      "type": "string",
      "description": "The post text or caption"
    },
    "scheduledFor": {
      "type": "string",
      "description": "ISO 8601 timestamp for when to post, in the future"
    },
    "requiresApproval": {
      "description": "Hold the post until someone approves it (in the dashboard or through a client review link)",
      "type": "boolean"
    },
    "mediaUrl": {
      "description": "A publicly accessible image or video URL to attach",
      "type": "string"
    },
    "mediaUrls": {
      "description": "Extra images after mediaUrl for a multi-image post. Call get_platform_rules for how many the platform takes",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "coverImageUrl": {
      "description": "A still cover image for a video (Pinterest video pins need one)",
      "type": "string"
    },
    "mediaAltText": {
      "description": "Accessibility description of the main image (Mastodon and Bluesky use it)",
      "type": "string"
    },
    "firstComment": {
      "description": "A first comment posted right after publishing (Facebook and Instagram only)",
      "type": "string"
    },
    "firstCommentDelayMinutes": {
      "description": "Wait this many minutes after the post goes live before posting firstComment (0 to 1440, Facebook and Instagram only). 0 or left out posts it right away. Needs firstComment",
      "type": "integer",
      "minimum": 0,
      "maximum": 1440
    },
    "tags": {
      "description": "Up to 5 short labels for filtering analytics by campaign",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "selfReplyText": {
      "description": "A follow-up comment added once the post reaches selfReplyAtLikes likes (Facebook and Instagram only)",
      "type": "string"
    },
    "selfReplyAtLikes": {
      "description": "The like count that triggers selfReplyText",
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "boardId": {
      "description": "Pinterest only: the board to pin to. Get it from list_pinterest_boards",
      "type": "string"
    },
    "destinationLink": {
      "description": "Pinterest only: where a click on the pin goes",
      "type": "string"
    },
    "tiktokPrivacyLevel": {
      "description": "TikTok only, REQUIRED for TikTok: call get_tiktok_creator_info to see which levels the account allows",
      "type": "string",
      "enum": [
        "PUBLIC_TO_EVERYONE",
        "MUTUAL_FOLLOW_FRIENDS",
        "SELF_ONLY"
      ]
    },
    "tiktokDisableComment": {
      "description": "TikTok only: turn comments off (default true, comments off)",
      "type": "boolean"
    },
    "tiktokDisableDuet": {
      "description": "TikTok only: turn duets off (default true)",
      "type": "boolean"
    },
    "tiktokDisableStitch": {
      "description": "TikTok only: turn stitches off (default true)",
      "type": "boolean"
    },
    "tiktokBrandOrganic": {
      "description": "TikTok only: the video promotes the creator's own brand",
      "type": "boolean"
    },
    "tiktokBrandContent": {
      "description": "TikTok only: the video is a paid partnership",
      "type": "boolean"
    },
    "options": {
      "description": "Platform-specific settings for the account you post to: tiktok {aiGenerated}; youtube {title, privacy public|unlisted|private, madeForKids, tags[], aiGenerated}; instagram {placement feed|reel|story, trialReel, trialGraduation manual|auto}; facebook {placement feed|story}; linkedin {documentUrl (https PDF), documentTitle}; threads, bluesky, mastodon and x {chain: [follow-up texts]} for a thread. Send only the key that belongs to the account's platform.",
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    }
  },
  "required": [
    "socialAccountId",
    "content",
    "scheduledFor"
  ],
  "additionalProperties": false
}
```

### publish_post_now

**Title:** Publish a post now

**Behaviour:** changes data, reaches a live platform.

**Description, exactly as the server sends it:**

```text
Publish to one connected account right away instead of scheduling. The scheduler picks it up within moments, it is not published synchronously: call list_scheduled_posts afterwards and check verifiedLive to confirm it really went live. Same fields as schedule_post.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "socialAccountId": {
      "type": "string",
      "description": "The connected account id to post to, from list_connected_accounts"
    },
    "content": {
      "type": "string",
      "description": "The post text or caption"
    },
    "mediaUrl": {
      "description": "A publicly accessible image or video URL to attach",
      "type": "string"
    },
    "mediaUrls": {
      "description": "Extra images after mediaUrl for a multi-image post. Call get_platform_rules for how many the platform takes",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "coverImageUrl": {
      "description": "A still cover image for a video (Pinterest video pins need one)",
      "type": "string"
    },
    "mediaAltText": {
      "description": "Accessibility description of the main image (Mastodon and Bluesky use it)",
      "type": "string"
    },
    "firstComment": {
      "description": "A first comment posted right after publishing (Facebook and Instagram only)",
      "type": "string"
    },
    "firstCommentDelayMinutes": {
      "description": "Wait this many minutes after the post goes live before posting firstComment (0 to 1440, Facebook and Instagram only). 0 or left out posts it right away. Needs firstComment",
      "type": "integer",
      "minimum": 0,
      "maximum": 1440
    },
    "tags": {
      "description": "Up to 5 short labels for filtering analytics by campaign",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "selfReplyText": {
      "description": "A follow-up comment added once the post reaches selfReplyAtLikes likes (Facebook and Instagram only)",
      "type": "string"
    },
    "selfReplyAtLikes": {
      "description": "The like count that triggers selfReplyText",
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "boardId": {
      "description": "Pinterest only: the board to pin to. Get it from list_pinterest_boards",
      "type": "string"
    },
    "destinationLink": {
      "description": "Pinterest only: where a click on the pin goes",
      "type": "string"
    },
    "tiktokPrivacyLevel": {
      "description": "TikTok only, REQUIRED for TikTok: call get_tiktok_creator_info to see which levels the account allows",
      "type": "string",
      "enum": [
        "PUBLIC_TO_EVERYONE",
        "MUTUAL_FOLLOW_FRIENDS",
        "SELF_ONLY"
      ]
    },
    "tiktokDisableComment": {
      "description": "TikTok only: turn comments off (default true, comments off)",
      "type": "boolean"
    },
    "tiktokDisableDuet": {
      "description": "TikTok only: turn duets off (default true)",
      "type": "boolean"
    },
    "tiktokDisableStitch": {
      "description": "TikTok only: turn stitches off (default true)",
      "type": "boolean"
    },
    "tiktokBrandOrganic": {
      "description": "TikTok only: the video promotes the creator's own brand",
      "type": "boolean"
    },
    "tiktokBrandContent": {
      "description": "TikTok only: the video is a paid partnership",
      "type": "boolean"
    },
    "options": {
      "description": "Platform-specific settings for the account you post to: tiktok {aiGenerated}; youtube {title, privacy public|unlisted|private, madeForKids, tags[], aiGenerated}; instagram {placement feed|reel|story, trialReel, trialGraduation manual|auto}; facebook {placement feed|story}; linkedin {documentUrl (https PDF), documentTitle}; threads, bluesky, mastodon and x {chain: [follow-up texts]} for a thread. Send only the key that belongs to the account's platform.",
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    }
  },
  "required": [
    "socialAccountId",
    "content"
  ],
  "additionalProperties": false
}
```

### create_draft

**Title:** Save a draft

**Behaviour:** changes data.

**Description, exactly as the server sends it:**

```text
Save a post as a draft without choosing an account or a time yet. It is never posted until it is scheduled with schedule_draft. Good for a plan a human will finish.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "content": {
      "type": "string",
      "description": "The draft text"
    },
    "mediaUrl": {
      "description": "A publicly accessible image or video URL to attach",
      "type": "string"
    },
    "mediaUrls": {
      "description": "Extra images after mediaUrl for a multi-image post. Call get_platform_rules for how many the platform takes",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "coverImageUrl": {
      "description": "A still cover image for a video (Pinterest video pins need one)",
      "type": "string"
    },
    "mediaAltText": {
      "description": "Accessibility description of the main image (Mastodon and Bluesky use it)",
      "type": "string"
    },
    "firstComment": {
      "description": "A first comment posted right after publishing (Facebook and Instagram only)",
      "type": "string"
    },
    "firstCommentDelayMinutes": {
      "description": "Wait this many minutes after the post goes live before posting firstComment (0 to 1440, Facebook and Instagram only). 0 or left out posts it right away. Needs firstComment",
      "type": "integer",
      "minimum": 0,
      "maximum": 1440
    },
    "tags": {
      "description": "Up to 5 short labels for filtering analytics by campaign",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "selfReplyText": {
      "description": "A follow-up comment added once the post reaches selfReplyAtLikes likes (Facebook and Instagram only)",
      "type": "string"
    },
    "selfReplyAtLikes": {
      "description": "The like count that triggers selfReplyText",
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "boardId": {
      "description": "Pinterest only: the board to pin to. Get it from list_pinterest_boards",
      "type": "string"
    },
    "destinationLink": {
      "description": "Pinterest only: where a click on the pin goes",
      "type": "string"
    },
    "tiktokPrivacyLevel": {
      "description": "TikTok only, REQUIRED for TikTok: call get_tiktok_creator_info to see which levels the account allows",
      "type": "string",
      "enum": [
        "PUBLIC_TO_EVERYONE",
        "MUTUAL_FOLLOW_FRIENDS",
        "SELF_ONLY"
      ]
    },
    "tiktokDisableComment": {
      "description": "TikTok only: turn comments off (default true, comments off)",
      "type": "boolean"
    },
    "tiktokDisableDuet": {
      "description": "TikTok only: turn duets off (default true)",
      "type": "boolean"
    },
    "tiktokDisableStitch": {
      "description": "TikTok only: turn stitches off (default true)",
      "type": "boolean"
    },
    "tiktokBrandOrganic": {
      "description": "TikTok only: the video promotes the creator's own brand",
      "type": "boolean"
    },
    "tiktokBrandContent": {
      "description": "TikTok only: the video is a paid partnership",
      "type": "boolean"
    },
    "options": {
      "description": "Platform-specific settings for the account you post to: tiktok {aiGenerated}; youtube {title, privacy public|unlisted|private, madeForKids, tags[], aiGenerated}; instagram {placement feed|reel|story, trialReel, trialGraduation manual|auto}; facebook {placement feed|story}; linkedin {documentUrl (https PDF), documentTitle}; threads, bluesky, mastodon and x {chain: [follow-up texts]} for a thread. Send only the key that belongs to the account's platform.",
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    }
  },
  "required": [
    "content"
  ],
  "additionalProperties": false
}
```

### schedule_draft

**Title:** Schedule a saved draft

**Behaviour:** changes data, reaches a live platform.

**Description, exactly as the server sends it:**

```text
Turn a draft into a real scheduled post by choosing the account and the time. The platform's rules are checked now, so an error here tells you what to fix.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "The post id, from list_scheduled_posts"
    },
    "socialAccountId": {
      "type": "string",
      "description": "The connected account id to post to"
    },
    "content": {
      "type": "string",
      "description": "The final post text"
    },
    "scheduledFor": {
      "type": "string",
      "description": "ISO 8601 timestamp for when to post, in the future"
    },
    "requiresApproval": {
      "type": "boolean"
    },
    "mediaUrl": {
      "description": "A publicly accessible image or video URL to attach",
      "type": "string"
    },
    "mediaUrls": {
      "description": "Extra images after mediaUrl for a multi-image post. Call get_platform_rules for how many the platform takes",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "coverImageUrl": {
      "description": "A still cover image for a video (Pinterest video pins need one)",
      "type": "string"
    },
    "mediaAltText": {
      "description": "Accessibility description of the main image (Mastodon and Bluesky use it)",
      "type": "string"
    },
    "firstComment": {
      "description": "A first comment posted right after publishing (Facebook and Instagram only)",
      "type": "string"
    },
    "firstCommentDelayMinutes": {
      "description": "Wait this many minutes after the post goes live before posting firstComment (0 to 1440, Facebook and Instagram only). 0 or left out posts it right away. Needs firstComment",
      "type": "integer",
      "minimum": 0,
      "maximum": 1440
    },
    "tags": {
      "description": "Up to 5 short labels for filtering analytics by campaign",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "selfReplyText": {
      "description": "A follow-up comment added once the post reaches selfReplyAtLikes likes (Facebook and Instagram only)",
      "type": "string"
    },
    "selfReplyAtLikes": {
      "description": "The like count that triggers selfReplyText",
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "boardId": {
      "description": "Pinterest only: the board to pin to. Get it from list_pinterest_boards",
      "type": "string"
    },
    "destinationLink": {
      "description": "Pinterest only: where a click on the pin goes",
      "type": "string"
    },
    "tiktokPrivacyLevel": {
      "description": "TikTok only, REQUIRED for TikTok: call get_tiktok_creator_info to see which levels the account allows",
      "type": "string",
      "enum": [
        "PUBLIC_TO_EVERYONE",
        "MUTUAL_FOLLOW_FRIENDS",
        "SELF_ONLY"
      ]
    },
    "tiktokDisableComment": {
      "description": "TikTok only: turn comments off (default true, comments off)",
      "type": "boolean"
    },
    "tiktokDisableDuet": {
      "description": "TikTok only: turn duets off (default true)",
      "type": "boolean"
    },
    "tiktokDisableStitch": {
      "description": "TikTok only: turn stitches off (default true)",
      "type": "boolean"
    },
    "tiktokBrandOrganic": {
      "description": "TikTok only: the video promotes the creator's own brand",
      "type": "boolean"
    },
    "tiktokBrandContent": {
      "description": "TikTok only: the video is a paid partnership",
      "type": "boolean"
    },
    "options": {
      "description": "Platform-specific settings for the account you post to: tiktok {aiGenerated}; youtube {title, privacy public|unlisted|private, madeForKids, tags[], aiGenerated}; instagram {placement feed|reel|story, trialReel, trialGraduation manual|auto}; facebook {placement feed|story}; linkedin {documentUrl (https PDF), documentTitle}; threads, bluesky, mastodon and x {chain: [follow-up texts]} for a thread. Send only the key that belongs to the account's platform.",
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    }
  },
  "required": [
    "id",
    "socialAccountId",
    "content",
    "scheduledFor"
  ],
  "additionalProperties": false
}
```

### update_post

**Title:** Edit a post

**Behaviour:** changes data, safe to repeat.

**Description, exactly as the server sends it:**

```text
Edit a draft, a post waiting for approval, or a still-pending post: its text, media, tags, options and so on. Not possible once it is posting or done. To change the time, use reschedule_post.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "The post id, from list_scheduled_posts"
    },
    "content": {
      "description": "New text",
      "type": "string"
    },
    "mediaUrl": {
      "description": "A publicly accessible image or video URL to attach",
      "type": "string"
    },
    "mediaUrls": {
      "description": "Extra images after mediaUrl for a multi-image post. Call get_platform_rules for how many the platform takes",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "coverImageUrl": {
      "description": "A still cover image for a video (Pinterest video pins need one)",
      "type": "string"
    },
    "mediaAltText": {
      "description": "Accessibility description of the main image (Mastodon and Bluesky use it)",
      "type": "string"
    },
    "firstComment": {
      "description": "A first comment posted right after publishing (Facebook and Instagram only)",
      "type": "string"
    },
    "firstCommentDelayMinutes": {
      "description": "Wait this many minutes after the post goes live before posting firstComment (0 to 1440, Facebook and Instagram only). 0 or left out posts it right away. Needs firstComment",
      "type": "integer",
      "minimum": 0,
      "maximum": 1440
    },
    "tags": {
      "description": "Up to 5 short labels for filtering analytics by campaign",
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "selfReplyText": {
      "description": "A follow-up comment added once the post reaches selfReplyAtLikes likes (Facebook and Instagram only)",
      "type": "string"
    },
    "selfReplyAtLikes": {
      "description": "The like count that triggers selfReplyText",
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "boardId": {
      "description": "Pinterest only: the board to pin to. Get it from list_pinterest_boards",
      "type": "string"
    },
    "destinationLink": {
      "description": "Pinterest only: where a click on the pin goes",
      "type": "string"
    },
    "tiktokPrivacyLevel": {
      "description": "TikTok only, REQUIRED for TikTok: call get_tiktok_creator_info to see which levels the account allows",
      "type": "string",
      "enum": [
        "PUBLIC_TO_EVERYONE",
        "MUTUAL_FOLLOW_FRIENDS",
        "SELF_ONLY"
      ]
    },
    "tiktokDisableComment": {
      "description": "TikTok only: turn comments off (default true, comments off)",
      "type": "boolean"
    },
    "tiktokDisableDuet": {
      "description": "TikTok only: turn duets off (default true)",
      "type": "boolean"
    },
    "tiktokDisableStitch": {
      "description": "TikTok only: turn stitches off (default true)",
      "type": "boolean"
    },
    "tiktokBrandOrganic": {
      "description": "TikTok only: the video promotes the creator's own brand",
      "type": "boolean"
    },
    "tiktokBrandContent": {
      "description": "TikTok only: the video is a paid partnership",
      "type": "boolean"
    },
    "options": {
      "description": "Platform-specific settings for the account you post to: tiktok {aiGenerated}; youtube {title, privacy public|unlisted|private, madeForKids, tags[], aiGenerated}; instagram {placement feed|reel|story, trialReel, trialGraduation manual|auto}; facebook {placement feed|story}; linkedin {documentUrl (https PDF), documentTitle}; threads, bluesky, mastodon and x {chain: [follow-up texts]} for a thread. Send only the key that belongs to the account's platform.",
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    }
  },
  "required": [
    "id"
  ],
  "additionalProperties": false
}
```

### reschedule_post

**Title:** Move a post to a new time

**Behaviour:** changes data, safe to repeat.

**Description, exactly as the server sends it:**

```text
Move a pending post to a new time. Passing the current time posts it right away. The platform's rules for that time are checked again.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "The post id, from list_scheduled_posts"
    },
    "scheduledFor": {
      "type": "string",
      "description": "ISO 8601 timestamp for the new time"
    }
  },
  "required": [
    "id",
    "scheduledFor"
  ],
  "additionalProperties": false
}
```

### pause_post

**Title:** Pause a pending post

**Behaviour:** changes data, safe to repeat.

**Description, exactly as the server sends it:**

```text
Hold a pending post so it does not go out at its time. Resume it later with resume_post.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "The post id, from list_scheduled_posts"
    }
  },
  "required": [
    "id"
  ],
  "additionalProperties": false
}
```

### resume_post

**Title:** Resume a paused post

**Behaviour:** changes data, safe to repeat.

**Description, exactly as the server sends it:**

```text
Let a paused post go out again. If its time has passed it goes out right away.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "The post id, from list_scheduled_posts"
    }
  },
  "required": [
    "id"
  ],
  "additionalProperties": false
}
```

### list_scheduled_posts

**Title:** List posts

**Behaviour:** read-only, safe to repeat.

**Description, exactly as the server sends it:**

```text
This account's upcoming and recent posts with their status (draft, needs_approval, pending, posted, failed) and whether each is confirmed live. Returns a short summary of each post; set detail to true for the full records. Filter by status or account to keep it small. The total in the answer is the number of posts returned after filtering and the limit, not the number of posts that exist.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "status": {
      "description": "Only posts with this status",
      "type": "string",
      "enum": [
        "draft",
        "needs_approval",
        "pending",
        "posting",
        "posted",
        "failed"
      ]
    },
    "socialAccountId": {
      "description": "Only posts for this account",
      "type": "string"
    },
    "limit": {
      "description": "At most this many posts, default 50",
      "type": "integer",
      "minimum": 1,
      "maximum": 200
    },
    "detail": {
      "description": "Return the full records instead of the short summary",
      "type": "boolean"
    }
  },
  "additionalProperties": false
}
```

### delete_scheduled_post

**Title:** Cancel a post

**Behaviour:** changes data, destructive, safe to repeat.

**Description, exactly as the server sends it:**

```text
Delete a post from LazyRelay. Use it to cancel a pending or waiting-for-approval post before it goes out. It also works on a post that has already gone out, but then it removes only LazyRelay's record: the post stays live on the platform. A post that is being published right now cannot be deleted, so try again in a moment.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "The post id, from list_scheduled_posts"
    }
  },
  "required": [
    "id"
  ],
  "additionalProperties": false
}
```

### get_proof_link

**Title:** Get a proof-of-publish link

**Behaviour:** read-only, safe to repeat.

**Description, exactly as the server sends it:**

```text
A public link that shows a post was really confirmed live, to share with a client. Only works for a post confirmed live, and the API key must be allowed to share proof.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "The post id, from list_scheduled_posts"
    }
  },
  "required": [
    "id"
  ],
  "additionalProperties": false
}
```

### approve_post

**Title:** Approve a waiting post

**Behaviour:** changes data, safe to repeat.

**Description, exactly as the server sends it:**

```text
Approve a post that is waiting for approval, so it is scheduled. Only do this when the account owner has asked you to.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "The post id, from list_scheduled_posts"
    }
  },
  "required": [
    "id"
  ],
  "additionalProperties": false
}
```

### create_review_link

**Title:** Create a client review link

**Behaviour:** changes data.

**Description, exactly as the server sends it:**

```text
Create a link a client opens (no account needed) to see the posts waiting for approval, approve them, ask for changes and comment. Send them the link at lazyrelay.com/review/<token>. Needs a plan that includes review links.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "label": {
      "description": "Who it is for, for example Acme",
      "type": "string"
    },
    "brandLabel": {
      "description": "Only show posts for this brand",
      "type": "string"
    },
    "expiresInDays": {
      "description": "Days until the link stops working, default 30",
      "type": "integer",
      "minimum": 1,
      "maximum": 90
    }
  },
  "additionalProperties": false
}
```

### list_review_links

**Title:** List client review links

**Behaviour:** read-only, safe to repeat.

**Description, exactly as the server sends it:**

```text
The account's client review links with their status and how many are allowed on the plan.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

### revoke_review_link

**Title:** Stop a client review link

**Behaviour:** changes data, destructive, safe to repeat.

**Description, exactly as the server sends it:**

```text
Stop a client review link working at once.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "The link id, from list_review_links"
    }
  },
  "required": [
    "id"
  ],
  "additionalProperties": false
}
```

### get_post_feedback

**Title:** Read client feedback on a post

**Behaviour:** read-only, safe to repeat.

**Description, exactly as the server sends it:**

```text
The conversation on a post waiting for approval: what the client said, whether they asked for changes, and any replies.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "The post id, from list_scheduled_posts"
    }
  },
  "required": [
    "id"
  ],
  "additionalProperties": false
}
```

### reply_to_post_feedback

**Title:** Reply to client feedback

**Behaviour:** changes data.

**Description, exactly as the server sends it:**

```text
Add a reply to the client conversation on a post. The client sees it on their review page.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "The post id, from list_scheduled_posts"
    },
    "body": {
      "type": "string",
      "description": "The reply, up to 1000 characters"
    }
  },
  "required": [
    "id",
    "body"
  ],
  "additionalProperties": false
}
```

### get_analytics_summary

**Title:** Get analytics

**Behaviour:** read-only, safe to repeat.

**Description, exactly as the server sends it:**

```text
Post counts, verified-live rate, per-platform breakdown and engagement totals for a recent window. Filter by brand or by a tag to compare campaigns; availableTags lists the tags in use.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "days": {
      "description": "How many days back, default 30",
      "type": "integer",
      "minimum": 1,
      "maximum": 90
    },
    "brand": {
      "description": "Only this brand",
      "type": "string"
    },
    "tag": {
      "description": "Only posts with this tag",
      "type": "string"
    }
  },
  "additionalProperties": false
}
```

### get_mentions

**Title:** Read recent comments

**Behaviour:** read-only, safe to repeat, reaches a live platform.

**Description, exactly as the server sends it:**

```text
Recent comments on this account's newest posts, from Dev.to, Hashnode, YouTube, Mastodon, Bluesky, Lemmy, WordPress, Telegram and Discord. Facebook and Instagram comments are included only where Meta allows LazyRelay to read them. LazyRelay keeps comments for up to 30 days, then deletes them.
```

**Input schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```
