# LazyRelay MCP Server

Connect any MCP-compatible AI agent (Claude Desktop, Claude Code, Cursor, and others) directly to your LazyRelay account — schedule and publish posts on every platform, look up each platform's rules, manage drafts and client approvals, and read analytics and comments without a browser.

This is a **local server** — it runs on your own machine and talks to LazyRelay's API using your own API key. There's no separate LazyRelay account or install step beyond this.

## Setup

1. Get an API key from your LazyRelay dashboard: **API Keys** tab (always visible in the top nav) → **Create key**. Copy it immediately — it's shown once.
2. Add this to your MCP client's config (for Claude Desktop, that's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "lazyrelay": {
      "command": "npx",
      "args": ["-y", "@lazyrelay/mcp-server"],
      "env": {
        "LAZYRELAY_API_KEY": "lzr_live_your_key_here"
      }
    }
  }
}
```

3. Restart your MCP client. You should see LazyRelay's tools available.

## Tools

| Tool | What it does |
|---|---|
| `list_connected_accounts` | List your connected social accounts and their ids |
| `list_workspaces` | List your brands (workspaces) |
| `get_platform_rules` | Look up what a platform accepts before posting: text limit, media rules, required fields, features and options |
| `get_tiktok_creator_info` | See which privacy levels and settings a TikTok account allows (needed before posting to TikTok) |
| `list_pinterest_boards` | List a Pinterest account's boards (a Pinterest post needs a board) |
| `get_next_free_slot` | Find the next free posting time from the times saved in Settings |
| `list_posting_slots` | List the saved posting times |
| `list_snippets` | List saved text snippets and the signature |
| `schedule_post` | Schedule a post to one account, with images, tags, TikTok settings, platform options and optional approval |
| `publish_post_now` | Publish to one account right away |
| `create_draft` | Save a draft without an account or a time |
| `schedule_draft` | Turn a saved draft into a scheduled post |
| `update_post` | Edit a draft, a post waiting for approval, or a pending post |
| `reschedule_post` | Move a pending post to a new time (the current time posts it right away) |
| `pause_post` | Hold a pending post so it does not go out |
| `resume_post` | Let a paused post go out again |
| `list_scheduled_posts` | See posts with status and whether each is confirmed live, filtered and summarised |
| `delete_scheduled_post` | Cancel a pending or waiting post |
| `get_proof_link` | Get a public proof-of-publish link for a post confirmed live |
| `approve_post` | Approve a post that is waiting for approval |
| `create_review_link` | Create a link a client opens, with no account, to approve posts and comment |
| `list_review_links` | List client review links and their status |
| `revoke_review_link` | Stop a client review link |
| `get_post_feedback` | Read the client's feedback on a post |
| `reply_to_post_feedback` | Reply to the client's feedback |
| `get_analytics_summary` | Post counts, verified-live rate, per-platform and per-tag results, engagement |
| `get_mentions` | Recent comments on your posts, where the platform allows reading them |

Every key acts as your account — treat it exactly like a password. Never share it or commit it to code.

## Local development

```bash
npm install
npm run build
LAZYRELAY_API_KEY=lzr_live_... npm start
```

## Prefer not to install anything?

LazyRelay also runs a hosted MCP server at `https://lazyrelaylazyrelay-backend.onrender.com/mcp`. Same 24 tools, but you sign in with your LazyRelay account instead of using an API key, nothing to run locally. In Claude, that's **Settings → Connectors → Add connector → Remote**, then paste the URL. For MCP clients that use a config file instead:

```json
{
  "mcpServers": {
    "lazyrelay": {
      "url": "https://lazyrelaylazyrelay-backend.onrender.com/mcp"
    }
  }
}
```

Full docs, including how to revoke access to a connected app later, are at [lazyrelay.com/docs](https://lazyrelay.com/docs).
