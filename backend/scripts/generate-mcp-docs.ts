// Regenerates the public MCP developer docs from the tool definitions. Run from the backend folder:
//   npx tsx scripts/generate-mcp-docs.ts
// Writes docs/mcp-integration.md and frontend/public/mcp/tools/index.html. mcpDocs.test.ts fails when either is stale.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureTools, renderHtml, renderMarkdown } from "../src/mcp/mcpDocs.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tools = captureTools();

const md = resolve(root, "docs/mcp-integration.md");
mkdirSync(dirname(md), { recursive: true });
writeFileSync(md, renderMarkdown(tools), "utf8");

const html = resolve(root, "frontend/public/mcp/tools/index.html");
mkdirSync(dirname(html), { recursive: true });
writeFileSync(html, renderHtml(tools), "utf8");

console.log(`Wrote ${tools.length} tools to ${md} and ${html}`);
