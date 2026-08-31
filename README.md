# LazyRelay

LazyRelay is a social media scheduler built around one idea: publishing shouldn't just look successful, it should be provable. Where most schedulers mark a post "sent" the moment an API call succeeds, LazyRelay's Proof-of-Publish independently verifies the post actually went live before it's marked confirmed. If verification fails, the post is flagged instead of silently marked successful.

Schedule to Facebook, TikTok, Pinterest, YouTube, LinkedIn, Threads, Mastodon, Bluesky, Telegram, Discord, and Tumblr — 11 platforms today (Instagram publishing is in Meta's app review process). Manage multiple brands from one account, with per-brand caps instead of a separate workspace fee for each one.

**Live product:** [lazyrelay.com](https://lazyrelay.com)

## MCP server

[`mcp-server/`](./mcp-server) is LazyRelay's official Model Context Protocol server, letting AI agents (Claude, Cursor, and others) schedule posts, check analytics, and read mentions directly. Published on npm as [`@lazyrelay/mcp-server`](https://www.npmjs.com/package/@lazyrelay/mcp-server) and listed in the official MCP Registry as `io.github.gosswerner1-max/lazyrelay-mcp-server`.

## About this repository

This is LazyRelay's product monorepo (`backend/`, `frontend/`, `mcp-server/`, and supporting tooling), made public to support MCP registry and directory listings. It's not open source and isn't accepting external contributions — all rights reserved.
