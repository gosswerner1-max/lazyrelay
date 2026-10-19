// The public MCP manifest (frontend/public/lazyrelay-mcp.json) is GENERATED from the real tool definitions, like the tools page.
// These tests fail when a tool changes and the file was not refreshed (run `npx tsx scripts/generate-mcp-manifest.ts` in backend/),
// so the manifest can never list a tool the server does not have, or a transport it does not serve.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, renderManifest } from "./mcpManifest.js";
import { LAZYRELAY_TOOL_NAMES } from "./lazyrelayTools.js";
import { MCP_FACTS } from "./mcpDocs.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");
const manifest = buildManifest();

describe("the manifest content", () => {
  it("lists exactly the 27 tools the server registers, in the same order", () => {
    expect(manifest.tools.map((t) => t.name)).toEqual([...LAZYRELAY_TOOL_NAMES]);
    expect(manifest.tools).toHaveLength(27);
    expect(manifest.toolCount).toBe(27);
  });

  it("lists no tool that does not exist (the three names from an earlier draft must never appear)", () => {
    const names = manifest.tools.map((t) => t.name);
    for (const invented of ["get_content_sources", "trigger_source_sync", "get_pending_drafts"]) expect(names).not.toContain(invented);
  });

  it("every tool has a title, a description, annotations and a JSON Schema for its arguments", () => {
    for (const t of manifest.tools) {
      expect(t.title.length, t.name).toBeGreaterThan(0);
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(Object.keys(t.annotations).sort(), t.name).toEqual(["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"]);
    }
    const schedule = manifest.tools.find((t) => t.name === "schedule_post")!;
    expect(Object.keys((schedule.inputSchema.properties ?? {}) as object)).toEqual(expect.arrayContaining(["socialAccountId", "content", "scheduledFor"]));
  });

  it("declares the two real transports: the local stdio package and the hosted streamable HTTP endpoint with OAuth", () => {
    const stdio = manifest.transports.find((t) => t.type === "stdio")!;
    expect(stdio).toMatchObject({ package: MCP_FACTS.npmPackage, command: "npx", args: ["-y", MCP_FACTS.npmPackage], environmentVariables: ["LAZYRELAY_API_KEY"] });
    const http = manifest.transports.find((t) => t.type === "streamable-http")!;
    expect(http).toMatchObject({ url: MCP_FACTS.hostedUrl, authentication: "oauth2" });
    expect(manifest.transports).toHaveLength(2);
  });

  it("points at the real pages and never at the bare site address as an MCP endpoint", () => {
    expect(manifest.homepage).toBe(MCP_FACTS.setupGuides);
    expect(manifest.toolsPage).toBe(MCP_FACTS.toolsPage);
    expect(manifest.transports.some((t) => "url" in t && t.url === "https://lazyrelay.com")).toBe(false);
  });

  it("holds no secret, no dash character and no private project name", () => {
    const text = renderManifest(manifest);
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/lzr_live_[A-Za-z0-9]|sbp_|BEGIN [A-Z ]*KEY|content.sources/i);
  });
});

describe("the generated file is up to date", () => {
  it("frontend/public/lazyrelay-mcp.json matches the tools", () => {
    expect(read("frontend/public/lazyrelay-mcp.json")).toBe(renderManifest(manifest));
  });

  it("is valid JSON", () => {
    expect(() => JSON.parse(read("frontend/public/lazyrelay-mcp.json"))).not.toThrow();
  });
});
