#!/usr/bin/env node
// LazyRelay's MCP server, local/stdio form. Works with Claude Desktop, Claude Code, Cursor and anything
// else that speaks MCP over stdio. A hosted, remote server (point your AI client at a URL, no install) lives
// in the LazyRelay backend and registers the SAME tools: they are defined once in tools.ts, which is a copy
// of backend/src/mcp/lazyrelayTools.ts (run `npm run sync-tools` after changing it in the backend).
//
// Auth is the customer's own lzr_live_ API key (self-serve, generated from the LazyRelay dashboard's
// Settings -> More -> API Keys), passed via the LAZYRELAY_API_KEY env var. Never hardcoded, never logged.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LazyRelayApiError, registerLazyRelayTools } from "./tools.js";

const API_BASE = process.env.LAZYRELAY_API_BASE ?? "https://lazyrelaylazyrelay-backend.onrender.com/api";
const API_KEY = process.env.LAZYRELAY_API_KEY;

if (!API_KEY) {
  console.error("LAZYRELAY_API_KEY is not set. Get one from your LazyRelay dashboard: Settings -> More -> API Keys -> Create key.");
  process.exit(1);
}

const server = new McpServer({ name: "lazyrelay", version: "0.2.1" });

registerLazyRelayTools(server, async (path, options) => {
  const res = await fetch(`${API_BASE}${path}`, {
    ...(options?.method ? { method: options.method } : {}),
    ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : `LazyRelay API error (HTTP ${res.status})`;
    throw new LazyRelayApiError(res.status, message);
  }
  return body;
});

const transport = new StdioServerTransport();
await server.connect(transport);
