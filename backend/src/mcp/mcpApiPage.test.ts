// The public MCP tools, webhooks and rate limits page is generated from the tool registration, and every number on it is taken from
// code. These tests fail when a tool changes and the page was not regenerated (run `npx tsx scripts/generate-mcp-api-page.ts` in
// backend/), or when a fact on the page stops matching the file it came from.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureTools } from "./mcpDocs.js";
import { LAZYRELAY_TOOL_NAMES } from "./lazyrelayTools.js";
import { EXPECTED_TOOL_COUNT, RATE_LIMIT_LADDER, TOOL_GROUPS, WEBHOOK_RETRY_WAITS, renderMcpApiPage, type PackageVersions } from "./mcpApiPage.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");
const version = (folder: string) => (JSON.parse(read(`${folder}/package.json`)) as { version: string }).version;

const versions: PackageVersions = {
  "@lazyrelay/mcp-server": version("mcp-server"),
  "@lazyrelay/sdk": version("sdk"),
  "n8n-nodes-lazyrelay": version("n8n-nodes-lazyrelay"),
};
const tools = captureTools();
const page = read("frontend/public/docs/mcp-api/index.html");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("the tool catalogue", () => {
  it("is exactly the 27 tools the server registers", () => {
    expect(tools).toHaveLength(27);
    expect(EXPECTED_TOOL_COUNT).toBe(27);
    expect(tools.map((t) => t.name)).toEqual([...LAZYRELAY_TOOL_NAMES]);
  });

  it("groups every tool exactly once", () => {
    const grouped = TOOL_GROUPS.flatMap((g) => g.tools);
    expect(grouped).toHaveLength(27);
    expect(new Set(grouped).size).toBe(27);
    expect([...grouped].sort()).toEqual([...LAZYRELAY_TOOL_NAMES].sort());
  });

  it("lists each tool's name and description byte for byte as the server registers them", () => {
    const rows = [...page.matchAll(/<tr><td class="tn"><a href="\/mcp\/tools\/#([a-z_]+)"><code>([a-z_]+)<\/code><\/a><\/td><td class="th">[\s\S]*?<\/td><td class="td">([\s\S]*?)<\/td><\/tr>/g)];
    expect(rows).toHaveLength(27);
    for (const [, anchor, name, desc] of rows) {
      const t = tools.find((x) => x.name === name)!;
      expect(t, name).toBeTruthy();
      expect(anchor).toBe(name);
      expect(unesc(desc), name).toBe(t.description);
    }
  });

  it("states each tool's annotations as the server declares them", () => {
    for (const t of tools) {
      const row = page.split("\n").find((l) => l.includes(`<code>${t.name}</code>`))!;
      expect(row.includes("read-only"), t.name).toBe(t.readOnly);
      expect(row.includes("changes data"), t.name).toBe(!t.readOnly);
      expect(row.includes("destructive"), t.name).toBe(t.destructive);
      expect(row.includes("safe to repeat"), t.name).toBe(t.idempotent);
      expect(row.includes("reaches a live platform"), t.name).toBe(t.openWorld);
    }
  });
});

describe("the committed page is up to date", () => {
  it("matches what the generator produces from the current tools and package versions", () => {
    expect(page).toBe(renderMcpApiPage(tools, versions));
  });

  it("refuses to render when the server registers a different number of tools", () => {
    expect(() => renderMcpApiPage(tools.slice(1), versions)).toThrow(/27/);
  });

  it("is plain ASCII with no em or en dash", () => {
    expect(/[^\x00-\x7F]/.test(page)).toBe(false);
    expect(/[–—]/.test(page)).toBe(false);
    expect(page).not.toMatch(/&[mn]dash;/);
  });
});

describe("the facts on the page match the code they come from", () => {
  it("rate limit ladder equals TIER_LIMITS in http/rateLimit.ts, by public plan name (code names are shifted by one)", () => {
    const src = read("backend/src/http/rateLimit.ts");
    const code: Record<string, number> = {};
    for (const m of src.matchAll(/^\s+(free|pro|business|enterprise|agency|agency_plus): (\d+),/gm)) code[m[1]] = Number(m[2]);
    const byPublicName: Record<string, string> = { Free: "free", Starter: "pro", Pro: "business", Business: "enterprise", Agency: "agency", "Agency Plus": "agency_plus" };
    for (const { plan, perMinute } of RATE_LIMIT_LADDER) expect(code[byPublicName[plan]], plan).toBe(perMinute);
    expect(src).toContain("windowMs: 60_000");
    for (const { plan, perMinute } of RATE_LIMIT_LADDER) expect(page, plan).toContain(`<td>${plan}</td><td>${perMinute} requests per minute</td>`);
    expect(src).toMatch(/export const mcpRateLimit/);
  });

  it("webhook retry waits, attempt count, timeout, headers and events equal webhook.ts and the SDK", () => {
    const src = read("backend/src/webhook.ts");
    const delays = /RETRY_DELAYS_MS = \[([^\]]+)\]/.exec(src)![1];
    expect(delays.replace(/\s/g, "")).toBe("60_000,5*60_000,30*60_000,2*60*60_000,6*60*60_000");
    expect(WEBHOOK_RETRY_WAITS).toEqual(["1 minute", "5 minutes", "30 minutes", "2 hours", "6 hours"]);
    expect(WEBHOOK_RETRY_WAITS.length + 1).toBe(6);
    expect(src).toContain("REQUEST_TIMEOUT_MS = 10_000");
    expect(src).toContain("MAX_WEBHOOK_ENDPOINTS = 5");
    for (const h of ["X-LazyRelay-Signature", "X-LazyRelay-Event", "X-LazyRelay-Delivery", "X-LazyRelay-Attempt"]) {
      expect(src, h).toContain(h);
      expect(page, h).toContain(h);
    }
    for (const e of ["post.verified", "post.failed", "post.unconfirmed", "channel.needs_reconnect"]) {
      expect(src, e).toContain(`"${e}"`);
      expect(page, e).toContain(`<code>${e}</code>`);
    }
    expect(src).toContain('createHmac("sha256"');
    expect(src).toContain('redirect: "manual"');
    expect(read("sdk/src/webhook.ts")).toContain("export function verifyWebhookSignature");
  });

  it("hosted MCP statements match mcpAuth.ts and mcpRoutes.ts", () => {
    const auth = read("backend/src/http/mcpAuth.ts");
    const routes = read("backend/src/http/mcpRoutes.ts");
    expect(auth).toContain('algorithms: ["ES256"]');
    expect(auth).toContain(".well-known/jwks.json");
    expect(auth).toContain('SUPABASE_DEFAULT_AUDIENCE = "authenticated"');
    expect(routes).toContain("sessionIdGenerator: undefined");
    expect(routes).toContain('"/mcp"');
    expect(routes).toContain("mcpAuthMetadataRouter");
  });

  it("API keys are SHA-256 hashed with the lzr_live_ prefix", () => {
    const auth = read("backend/src/http/auth.ts");
    expect(auth).toContain('API_KEY_PREFIX = "lzr_live_"');
    expect(auth).toContain('createHash("sha256")');
  });

  it("package versions on the page are the ones in each package.json", () => {
    for (const [name, v] of Object.entries(versions)) expect(page, name).toContain(`${name} ${v}`);
  });
});
