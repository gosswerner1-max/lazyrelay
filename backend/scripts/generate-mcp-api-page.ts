// Regenerates the public "MCP tools, webhooks and rate limits" page. Run from the backend folder:
//   npx tsx scripts/generate-mcp-api-page.ts
// Writes frontend/public/docs/mcp-api/index.html. The tool catalogue is read from the real tool registration (captureTools), and the
// package versions from the package.json files, so none of it is retyped. Fails unless the server registers exactly the 27 tools the
// site states. mcpApiPage.test.ts fails when the committed page is stale.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureTools } from "../src/mcp/mcpDocs.js";
import { renderMcpApiPage, type PackageVersions } from "../src/mcp/mcpApiPage.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function version(folder: string): string {
  return (JSON.parse(readFileSync(resolve(root, folder, "package.json"), "utf8")) as { version: string }).version;
}

const versions: PackageVersions = {
  "@lazyrelay/mcp-server": version("mcp-server"),
  "@lazyrelay/sdk": version("sdk"),
  "n8n-nodes-lazyrelay": version("n8n-nodes-lazyrelay"),
};

const tools = captureTools();
const html = renderMcpApiPage(tools, versions);

const out = resolve(root, "frontend/public/docs/mcp-api/index.html");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html, "utf8");
console.log(`Wrote ${tools.length} tools to ${out}`);
