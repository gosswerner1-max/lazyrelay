// The public MCP developer docs are generated from the tool definitions. These tests fail when a tool changes and the
// generated files were not refreshed (run `npx tsx scripts/generate-mcp-docs.ts` in backend/), so the page can never
// quietly say something different from what an agent receives.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureTools, renderHtml, renderMarkdown, ERROR_KINDS, MCP_FACTS } from "./mcpDocs.js";
import { LAZYRELAY_TOOL_NAMES, describeApiError } from "./lazyrelayTools.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");
const tools = captureTools();

describe("captured tools", () => {
  it("are exactly the tools the server registers, in the same order", () => {
    expect(tools.map((t) => t.name)).toEqual([...LAZYRELAY_TOOL_NAMES]);
    expect(tools).toHaveLength(27);
  });

  it("every tool has a title, a description and a JSON Schema for its arguments", () => {
    for (const t of tools) {
      expect(t.title.length, t.name).toBeGreaterThan(0);
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(t.inputSchema.$schema, t.name).toBeUndefined();
    }
  });

  it("carries a real schema, not an empty one, for a tool with arguments", () => {
    const schedule = tools.find((t) => t.name === "schedule_post")!;
    const props = (schedule.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["socialAccountId", "content", "scheduledFor", "mediaUrl"]));
    expect(schedule.inputSchema.required).toEqual(expect.arrayContaining(["socialAccountId", "content"]));
  });
});

describe("the generated files are up to date", () => {
  it("docs/mcp-integration.md matches the tools", () => {
    expect(read("docs/mcp-integration.md")).toBe(renderMarkdown(tools));
  });

  it("frontend/public/mcp/tools/index.html matches the tools", () => {
    expect(read("frontend/public/mcp/tools/index.html")).toBe(renderHtml(tools));
  });

  it("the markdown holds every description verbatim", () => {
    const md = read("docs/mcp-integration.md");
    for (const t of tools) expect(md.includes(t.description), t.name).toBe(true);
  });
});

describe("the tool count the site states matches the server", () => {
  it("the frontend constant, llms.txt, the home page data and the generated docs all give the number of registered tools", () => {
    const n = tools.length;
    expect(read("frontend/src/lib/homeSchema.ts")).toContain(`MCP_TOOL_COUNT = ${n};`);
    expect(read("frontend/public/llms.txt")).toContain(`All ${n} MCP tools`);
    expect(read("frontend/index.html")).toContain(`MCP server with ${n} tools`);
    expect(read("docs/mcp-integration.md").split("\n").filter((l) => l.startsWith("### ")).length).toBe(n);
  });
});

describe("where the docs say the server is listed", () => {
  it("the registry name is the one in mcp-server/server.json, and the Glama and registry entries are in the docs and llms.txt", () => {
    const manifest = JSON.parse(read("mcp-server/server.json")) as { name: string; packages: Array<{ identifier: string }> };
    expect(MCP_FACTS.registryName).toBe(manifest.name);
    expect(MCP_FACTS.npmPackage).toBe(manifest.packages[0].identifier);
    const md = read("docs/mcp-integration.md");
    for (const url of [MCP_FACTS.glamaServer, MCP_FACTS.glamaConnector, MCP_FACTS.registryName]) expect(md, url).toContain(url);
    expect(read("frontend/public/llms.txt")).toContain(MCP_FACTS.glamaServer);
  });
});

describe("what the docs say is true", () => {
  it("the error kinds listed are the kinds the server can return", () => {
    for (const status of [400, 401, 403, 404, 409, 429, 500, 418]) expect(ERROR_KINDS as readonly string[]).toContain(describeApiError(status, "x").kind);
  });

  it("the delete tool does not claim a posted post is untouched", () => {
    const d = tools.find((t) => t.name === "delete_scheduled_post")!.description;
    expect(d).toMatch(/stays live on the platform/);
    expect(d).not.toMatch(/no effect/i);
  });

  it("get_mentions names the nine live platforms", () => {
    const d = tools.find((t) => t.name === "get_mentions")!.description;
    for (const name of ["Dev.to", "Hashnode", "YouTube", "Mastodon", "Bluesky", "Lemmy", "WordPress", "Telegram", "Discord"]) expect(d).toContain(name);
  });
});
