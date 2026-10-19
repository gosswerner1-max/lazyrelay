// Regenerates the public MCP manifest from the tool definitions. Run from the backend folder:
//   npx tsx scripts/generate-mcp-manifest.ts
// Writes frontend/public/lazyrelay-mcp.json. mcpManifest.test.ts fails when it is stale.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, renderManifest } from "../src/mcp/mcpManifest.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = buildManifest();
const out = resolve(root, "frontend/public/lazyrelay-mcp.json");
writeFileSync(out, renderManifest(manifest), "utf8");

console.log(`Wrote ${manifest.tools.length} tools to ${out}`);
