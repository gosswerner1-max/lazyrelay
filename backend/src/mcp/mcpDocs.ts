// The public MCP developer documentation, GENERATED from the tool definitions themselves (lazyrelayTools.ts), so the
// names, descriptions and input schemas on the page are exactly what an agent receives from the server, never retyped.
// Written to docs/mcp-integration.md and frontend/public/mcp/tools/index.html by backend/scripts/generate-mcp-docs.ts;
// mcpDocs.test.ts fails if either file is out of date with the tools.

import { z } from "zod";
import { registerLazyRelayTools, LAZYRELAY_TOOL_NAMES } from "./lazyrelayTools.js";

export interface CapturedTool {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
  /** JSON Schema of the tool's arguments, as zod produces it. */
  inputSchema: Record<string, unknown>;
}

/** Runs the real registration against a stand-in server that only records what each tool declares. */
export function captureTools(): CapturedTool[] {
  const tools: CapturedTool[] = [];
  const recorder = {
    tool(name: string, description: string, shape: Record<string, z.ZodType>, annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }) {
      const schema = z.toJSONSchema(z.object(shape)) as Record<string, unknown>;
      delete schema.$schema;
      tools.push({
        name,
        title: annotations.title,
        description,
        readOnly: annotations.readOnlyHint,
        destructive: annotations.destructiveHint,
        idempotent: annotations.idempotentHint,
        openWorld: annotations.openWorldHint,
        inputSchema: schema,
      });
    },
  };
  registerLazyRelayTools(recorder as never, async () => ({}));
  return tools;
}

export const MCP_FACTS = {
  hostedUrl: "https://lazyrelaylazyrelay-backend.onrender.com/mcp",
  npmPackage: "@lazyrelay/mcp-server",
  setupGuides: "https://lazyrelay.com/mcp/",
  restDocs: "https://lazyrelay.com/docs/",
  openApi: "https://lazyrelaylazyrelay-backend.onrender.com/api/openapi.json",
  toolsPage: "https://lazyrelay.com/mcp/tools/",
  // Where the server is listed. Glama and the official MCP Registry hold these entries on their own side (verified live 2026-10-07);
  // the registry name is the one in mcp-server/server.json, and mcpDocs.test.ts checks they match.
  glamaServer: "https://glama.ai/mcp/servers/gosswerner1-max/lazyrelay",
  glamaConnector: "https://glama.ai/mcp/connectors/com.onrender.lazyrelaylazyrelay-backend/lazy-relay",
  registryName: "io.github.gosswerner1-max/lazyrelay-mcp-server",
  registryUrl: "https://registry.modelcontextprotocol.io/v0/servers?search=lazyrelay",
} as const;

/** The error kinds a tool can return, as lazyrelayTools.ts defines them. */
export const ERROR_KINDS = ["validation", "plan_limit", "auth", "permission", "not_found", "conflict", "rate_limited", "server", "unknown"] as const;

function safety(t: CapturedTool): string {
  const parts = [t.readOnly ? "read-only" : "changes data"];
  if (t.destructive) parts.push("destructive");
  if (t.idempotent) parts.push("safe to repeat");
  if (t.openWorld) parts.push("reaches a live platform");
  return parts.join(", ");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderMarkdown(tools: CapturedTool[] = captureTools()): string {
  const n = tools.length;
  const lines: string[] = [];
  lines.push("# LazyRelay MCP integration");
  lines.push("");
  lines.push(`LazyRelay exposes ${n} tools over the Model Context Protocol, so an AI agent or editor can schedule posts, check whether a post is really live, listen to the comments on your own posts and manage drafts on a LazyRelay account. This page lists every tool exactly as the server describes it, with its full input schema. It is generated from the server's own tool definitions, so it cannot drift from what an agent receives.`);
  lines.push("");
  lines.push("## Connect");
  lines.push("");
  lines.push("There are two ways to connect. Both expose the same tools.");
  lines.push("");
  lines.push(`1. **Hosted server (sign in with your LazyRelay account).** Add a custom remote MCP connector in your client and point it at \`${MCP_FACTS.hostedUrl}\`. The client signs you in with OAuth. Nothing to install.`);
  lines.push(`2. **Local server (API key).** Run the \`${MCP_FACTS.npmPackage}\` package with an API key from the **API Keys** tab of the dashboard:`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify({ mcpServers: { lazyrelay: { command: "npx", args: ["-y", MCP_FACTS.npmPackage], env: { LAZYRELAY_API_KEY: "lzr_live_your_key_here" } } } }, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("An API key acts as your account, so treat it like a password. It is shown once when you create it.");
  lines.push("");
  lines.push(`Setup guides for 15 AI agents and editors are at ${MCP_FACTS.setupGuides}. MCP and API-key access is included on every plan, including Free. The REST API behind the tools is documented at ${MCP_FACTS.restDocs} and described in OpenAPI 3.1 at ${MCP_FACTS.openApi}.`);
  lines.push("");
  lines.push("## Where the server is listed");
  lines.push("");
  lines.push(`- **Glama, as a server:** ${MCP_FACTS.glamaServer} (built from the public repository).`);
  lines.push(`- **Glama, as a connector:** ${MCP_FACTS.glamaConnector} (the hosted server, OAuth sign-in, no API key).`);
  lines.push(`- **Official MCP Registry:** \`${MCP_FACTS.registryName}\`, package \`${MCP_FACTS.npmPackage}\`. Look it up at ${MCP_FACTS.registryUrl}.`);
  lines.push("");
  lines.push("## How the tools behave");
  lines.push("");
  lines.push("- Every tool is a thin call to LazyRelay's own REST API, so plan limits, validation and platform rules are enforced in one place, whichever way you connect.");
  lines.push("- Each tool declares whether it is read-only, whether it is destructive, whether it is safe to repeat, and whether it reaches a live platform (MCP annotations). Clients can use these to decide what to confirm with you.");
  lines.push("- A failed call returns `isError: true` with a JSON body of the form `{ \"error\": { \"kind\", \"status\", \"message\", \"hint\", \"retryable\" } }`. `kind` is one of: " + ERROR_KINDS.map((k) => `\`${k}\``).join(", ") + ". `hint` says what to call or change next when LazyRelay knows, and `retryable` is true only for rate limits and server errors.");
  lines.push("");
  lines.push(`## The ${n} tools`);
  lines.push("");
  lines.push("| Tool | Title | Behaviour |");
  lines.push("|---|---|---|");
  for (const t of tools) lines.push(`| [\`${t.name}\`](#${t.name}) | ${t.title} | ${safety(t)} |`);
  lines.push("");
  for (const t of tools) {
    lines.push(`### ${t.name}`);
    lines.push("");
    lines.push(`**Title:** ${t.title}`);
    lines.push("");
    lines.push(`**Behaviour:** ${safety(t)}.`);
    lines.push("");
    lines.push("**Description, exactly as the server sends it:**");
    lines.push("");
    lines.push("```text");
    lines.push(t.description);
    lines.push("```");
    lines.push("");
    lines.push("**Input schema (JSON Schema):**");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(t.inputSchema, null, 2));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f5f6f8; color: #5b6472; margin: 0; line-height: 1.65; }
  header, footer { max-width: 860px; margin: 0 auto; padding: 24px; }
  main { max-width: 860px; margin: 0 auto; padding: 0 24px 48px; background: #fff; }
  .wordmark { display: flex; align-items: center; gap: 8px; font-family: Georgia, serif; font-weight: 700; font-size: 20px; color: #14171f; }
  .wordmark .dot { color: #ff5630; }
  a { color: #c82400; }
  a.back { display: inline-block; margin-bottom: 24px; text-decoration: none; color: #c82400; }
  h1 { font-family: Georgia, serif; color: #14171f; font-size: 36px; margin-bottom: 10px; line-height: 1.2; }
  h2 { font-family: Georgia, serif; color: #14171f; font-size: 22px; margin-top: 48px; }
  h3 { font-family: Georgia, serif; color: #14171f; font-size: 18px; margin: 36px 0 6px; }
  .subtitle { color: #5b6472; font-size: 17px; margin-top: 0; margin-bottom: 20px; max-width: 700px; }
  .note { color: #5b6472; font-size: 14px; }
  strong { color: #14171f; }
  ol, ul { padding-left: 22px; }
  li { margin-bottom: 8px; }
  code { background: #f0f1f3; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  pre { background: #f0f1f3; padding: 14px 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; border-bottom: 1px solid #e5e7eb; padding: 8px 10px; vertical-align: top; }
  .tool { border-top: 1px solid #e5e7eb; }
`;

export function renderHtml(tools: CapturedTool[] = captureTools()): string {
  const n = tools.length;
  const title = `LazyRelay MCP Server: All ${n} Tools and Input Schemas | LazyRelay`;
  const description = `Every tool the LazyRelay MCP server exposes to AI agents (${n} in total), with its exact description and full input schema. Connect through the hosted server or the local npm package.`;
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "LazyRelay MCP tools",
    numberOfItems: n,
    itemListElement: tools.map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, description: t.description })),
  };
  const body: string[] = [];
  body.push('<a class="back" href="/mcp/">&larr; Back to AI agent integrations</a>');
  body.push("<h1>LazyRelay MCP Server: Tools and Input Schemas</h1>");
  body.push(`<p class="subtitle">LazyRelay exposes ${n} tools over the Model Context Protocol, including a listening stream for comments on your own posts. Each is listed below exactly as the server describes it to an AI agent, with its full input schema. This page is generated from the server's own tool definitions.</p>`);
  body.push("<h2>Connect</h2>");
  body.push("<ol>");
  body.push(`<li><strong>Hosted server.</strong> Add a custom remote MCP connector in your client and point it at <code>${esc(MCP_FACTS.hostedUrl)}</code>. The client signs you in with OAuth.</li>`);
  body.push(`<li><strong>Local server.</strong> Run <code>npx -y ${esc(MCP_FACTS.npmPackage)}</code> with <code>LAZYRELAY_API_KEY</code> set to an API key from the API Keys tab of the dashboard. A key acts as your account, so treat it like a password.</li>`);
  body.push("</ol>");
  body.push(`<p>MCP and API-key access is included on every plan, including Free. <a href="/mcp/">Setup guides for 15 AI agents and editors</a> &middot; <a href="/docs/">REST API docs</a> &middot; <a href="${esc(MCP_FACTS.openApi)}">OpenAPI 3.1</a></p>`);
  body.push("<h2>Where the server is listed</h2>");
  body.push("<ul>");
  body.push(`<li><strong>Glama, as a server:</strong> <a href="${esc(MCP_FACTS.glamaServer)}">${esc(MCP_FACTS.glamaServer)}</a> (built from the public repository).</li>`);
  body.push(`<li><strong>Glama, as a connector:</strong> <a href="${esc(MCP_FACTS.glamaConnector)}">${esc(MCP_FACTS.glamaConnector)}</a> (the hosted server, OAuth sign-in, no API key).</li>`);
  body.push(`<li><strong>Official MCP Registry:</strong> <code>${esc(MCP_FACTS.registryName)}</code>, package <code>${esc(MCP_FACTS.npmPackage)}</code>. <a href="${esc(MCP_FACTS.registryUrl)}">Look it up in the registry</a>.</li>`);
  body.push("</ul>");
  body.push("<h2>How the tools behave</h2>");
  body.push("<ul>");
  body.push("<li>Every tool is a thin call to LazyRelay's own REST API, so plan limits, validation and platform rules are enforced in one place, whichever way you connect.</li>");
  body.push("<li>Each tool declares whether it is read-only, destructive, safe to repeat, and whether it reaches a live platform, so a client can decide what to confirm with you.</li>");
  body.push(`<li>A failed call returns <code>isError: true</code> with <code>{ "error": { "kind", "status", "message", "hint", "retryable" } }</code>. <code>kind</code> is one of ${ERROR_KINDS.map((k) => `<code>${k}</code>`).join(", ")}.</li>`);
  body.push("</ul>");
  body.push(`<h2>The ${n} tools</h2>`);
  body.push("<table><thead><tr><th>Tool</th><th>Title</th><th>Behaviour</th></tr></thead><tbody>");
  for (const t of tools) body.push(`<tr><td><a href="#${t.name}"><code>${t.name}</code></a></td><td>${esc(t.title)}</td><td>${esc(safety(t))}</td></tr>`);
  body.push("</tbody></table>");
  for (const t of tools) {
    body.push(`<section class="tool" id="${t.name}">`);
    body.push(`<h3>${t.name}</h3>`);
    body.push(`<p><strong>Title:</strong> ${esc(t.title)}<br><strong>Behaviour:</strong> ${esc(safety(t))}.</p>`);
    body.push("<p><strong>Description, exactly as the server sends it:</strong></p>");
    body.push(`<pre><code>${esc(t.description)}</code></pre>`);
    body.push("<p><strong>Input schema (JSON Schema):</strong></p>");
    body.push(`<pre><code>${esc(JSON.stringify(t.inputSchema, null, 2))}</code></pre>`);
    body.push("</section>");
  }
  const ld = JSON.stringify(itemList).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${MCP_FACTS.toolsPage}" />
<link rel="icon" type="image/png" href="/favicon.png" />
<script src="/consent.js" defer></script>
<style>${PAGE_STYLE}</style>
<script type="application/ld+json">${ld}</script>
</head>
<body>
<header><div class="wordmark">Lazy<span class="dot">Relay</span></div></header>
<main>
${body.join("\n")}
</main>
<footer>
  <p><a href="/">Home</a> &middot; <a href="/guides">Guides</a> &middot; <a href="/pricing">Pricing</a> &middot; <a href="/docs">API &amp; MCP Docs</a> &middot; <a href="/terms">Terms of Service</a> &middot; <a href="/privacy">Privacy Policy</a></p>
  <p class="note">&copy; 2026 LazyRelay. All rights reserved.</p>
</footer>
</body>
</html>
`;
}

export { LAZYRELAY_TOOL_NAMES };
