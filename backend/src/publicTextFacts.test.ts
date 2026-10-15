// Companion to frontend/src/lib/publicPageFacts.test.ts. These files sit outside the frontend folder, which Vite will not serve to a
// frontend test, so they are read here. Each block asserts a wrong public statement is gone and the corrected fact is present.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");

describe("item 5: API Keys is a main dashboard tab, not under More or Settings", () => {
  it.each([
    "mcp-server/README.md",
    "mcp-server/server.json",
    "mcp-server/src/index.ts",
    "zapier-integration/authentication.js",
    "zapier-integration/README.md",
    "zapier-integration/.env.example",
  ])("%s", (file) => {
    const text = read(file);
    expect(text).not.toMatch(/More (&rarr;|→|->) API Keys/);
    expect(text).not.toMatch(/Settings (&rarr;|→|->) (More (&rarr;|→|->) )?API Keys/);
    expect(text).toMatch(/API Keys\*{0,2} tab/);
  });
  it("the Zapier key field no longer says a paid plan is required (Free can create keys)", () => {
    expect(read("zapier-integration/authentication.js")).not.toContain("Requires a paid plan");
  });
});

describe("item 6: the hosted MCP server has 27 tools", () => {
  it("README does not say 24", () => {
    const text = read("mcp-server/README.md");
    expect(text).not.toMatch(/Same (6|24) tools/);
    expect(text).toContain("Same 27 tools");
  });
});

describe("item 11: old 12 platforms ad copy", () => {
  it.each(["backend/src/schedule-launch-ad-batch.ts", "backend/src/fix-tiktok-youtube-video-swap.ts"])("%s", (file) => {
    const text = read(file);
    expect(text).not.toContain("across 12 platforms");
    expect(text).not.toContain("into 12 dashboards");
  });
});

describe("the MCP tool file is still byte-identical to the mcp-server copy", () => {
  it("backend/src/mcp/lazyrelayTools.ts == mcp-server/src/tools.ts", () => {
    expect(read("mcp-server/src/tools.ts")).toBe(read("backend/src/mcp/lazyrelayTools.ts"));
  });
});
