# LazyRelay MCP Server

Connect any MCP-compatible AI agent (Claude Desktop, Claude Code, Cursor, and others) directly to your LazyRelay account — schedule posts, check analytics, and read comments without a browser.

This is a **local server** — it runs on your own machine and talks to LazyRelay's API using your own API key. There's no separate LazyRelay account or install step beyond this.

## Setup

1. Get an API key from your LazyRelay dashboard: **Settings → More → API Keys → Create key**. Copy it immediately — it's shown once.
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
| `schedule_post` | Schedule a post to one connected account |
| `list_scheduled_posts` | See upcoming and recent posts, with status and Proof-of-Publish verification |
| `delete_scheduled_post` | Cancel a pending post |
| `get_analytics_summary` | Post counts, verified-live rate, per-platform breakdown, engagement totals |
| `get_mentions` | Recent comments on your posts, where the platform supports reading them |

Every key acts as your account — treat it exactly like a password. Never share it or commit it to code.

## Local development

```bash
npm install
npm run build
LAZYRELAY_API_KEY=lzr_live_... npm start
```

## Prefer not to install anything?

LazyRelay also runs a hosted MCP server at `https://lazyrelaylazyrelay-backend.onrender.com/mcp`. Same 6 tools, but you sign in with your LazyRelay account instead of using an API key, nothing to run locally. In Claude, that's **Settings → Connectors → Add connector → Remote**, then paste the URL. For MCP clients that use a config file instead:

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
