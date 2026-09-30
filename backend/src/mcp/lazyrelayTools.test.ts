// The shared MCP tools, exercised through a REAL MCP client talking to a REAL server over an in-memory
// transport (the protocol itself is not mocked). Only the REST call the tools make is replaced.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LAZYRELAY_TOOL_NAMES, LazyRelayApiError, describeApiError, registerLazyRelayTools } from "./lazyrelayTools.js";

type Call = { path: string; method?: string; body?: unknown; extra: unknown };
let calls: Call[];
let respond: (path: string, method?: string) => unknown;

async function connect() {
  const server = new McpServer({ name: "test", version: "0" });
  registerLazyRelayTools(server, async (path, options, extra) => {
    calls.push({ path, method: options?.method, body: options?.body, extra });
    return respond(path, options?.method);
  });
  const client = new Client({ name: "test-client", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const text = (r: unknown) => JSON.parse(((r as { content: Array<{ text: string }> }).content[0]).text);

beforeEach(() => {
  calls = [];
  respond = () => ({});
});

describe("the tool list", () => {
  it("offers every tool, each with a title and honest read/write hints", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...LAZYRELAY_TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.description && t.description.length > 20, t.name).toBe(true);
      expect(t.annotations?.title, t.name).toBeTruthy();
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe("boolean");
      expect(typeof t.annotations?.destructiveHint, t.name).toBe("boolean");
    }
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(by.list_scheduled_posts).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(by.get_platform_rules).toMatchObject({ readOnlyHint: true });
    expect(by.delete_scheduled_post).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(by.revoke_review_link).toMatchObject({ destructiveHint: true });
    expect(by.schedule_post).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  });

  it("the local package's copy is identical to the source, so the two servers cannot drift", () => {
    const backend = readFileSync(new URL("./lazyrelayTools.ts", import.meta.url), "utf8");
    const local = readFileSync(new URL("../../../mcp-server/src/tools.ts", import.meta.url), "utf8");
    expect(local).toBe(backend);
  });
});

describe("agent-scheduled posts carry everything a platform needs (the TikTok case used to fail)", () => {
  it("schedule_post forwards TikTok privacy, comment flags, AI label and approval", async () => {
    const client = await connect();
    await client.callTool({
      name: "schedule_post",
      arguments: {
        socialAccountId: "tt1",
        content: "Video",
        scheduledFor: "2026-10-01T09:00:00Z",
        mediaUrl: "https://x/v.mp4",
        tiktokPrivacyLevel: "PUBLIC_TO_EVERYONE",
        tiktokDisableComment: false,
        options: { tiktok: { aiGenerated: true } },
        requiresApproval: true,
        tags: ["launch"],
      },
    });
    expect(calls[0]).toMatchObject({ path: "/scheduled-posts", method: "POST" });
    expect(calls[0].body).toMatchObject({ socialAccountId: "tt1", tiktokPrivacyLevel: "PUBLIC_TO_EVERYONE", tiktokDisableComment: false, options: { tiktok: { aiGenerated: true } }, requiresApproval: true, tags: ["launch"] });
  });

  it("refuses a TikTok privacy level that does not exist, before any call", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "schedule_post", arguments: { socialAccountId: "tt1", content: "x", scheduledFor: "2026-10-01T09:00:00Z", tiktokPrivacyLevel: "EVERYONE" } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("Pinterest fields are sent, and publish_post_now posts right now", async () => {
    const client = await connect();
    await client.callTool({ name: "publish_post_now", arguments: { socialAccountId: "p1", content: "Pin", mediaUrl: "https://x/i.jpg", boardId: "b1", destinationLink: "https://x.com" } });
    const body = calls[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ boardId: "b1", destinationLink: "https://x.com" });
    expect(Math.abs(new Date(body.scheduledFor as string).getTime() - Date.now())).toBeLessThan(10_000);
  });
});

describe("lookups", () => {
  it("route to the right REST paths", async () => {
    const client = await connect();
    await client.callTool({ name: "get_platform_rules", arguments: {} });
    await client.callTool({ name: "get_platform_rules", arguments: { platform: "tiktok" } });
    await client.callTool({ name: "get_tiktok_creator_info", arguments: { socialAccountId: "a b" } });
    await client.callTool({ name: "list_pinterest_boards", arguments: { socialAccountId: "p1" } });
    await client.callTool({ name: "get_next_free_slot", arguments: { socialAccountId: "ig" } });
    await client.callTool({ name: "get_analytics_summary", arguments: { days: 7, brand: "Acme Co", tag: "launch" } });
    expect(calls.map((c) => c.path)).toEqual([
      "/platforms/rules",
      "/platforms/rules?platform=tiktok",
      "/social-accounts/a%20b/tiktok-creator-info",
      "/social-accounts/p1/boards",
      "/posting-slots/next?socialAccountId=ig",
      "/analytics/summary?days=7&brand=Acme%20Co&tag=launch",
    ]);
  });
});

describe("drafts, approval and review links", () => {
  it("create_draft, schedule_draft and update_post use the draft routes", async () => {
    const client = await connect();
    await client.callTool({ name: "create_draft", arguments: { content: "Plan", tags: ["a"] } });
    await client.callTool({ name: "schedule_draft", arguments: { id: "d1", socialAccountId: "ig", content: "Final", scheduledFor: "2026-10-01T09:00:00Z" } });
    await client.callTool({ name: "update_post", arguments: { id: "d1", content: "Edited" } });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /scheduled-posts/draft", "PATCH /scheduled-posts/d1/schedule", "PATCH /scheduled-posts/d1"]);
    expect(calls[1].body).toEqual({ socialAccountId: "ig", content: "Final", scheduledFor: "2026-10-01T09:00:00Z" }); // the id is in the path, not the body
  });

  it("approve, proof link, feedback and replies", async () => {
    const client = await connect();
    await client.callTool({ name: "approve_post", arguments: { id: "p1" } });
    await client.callTool({ name: "get_proof_link", arguments: { id: "p1" } });
    await client.callTool({ name: "get_post_feedback", arguments: { id: "p1" } });
    await client.callTool({ name: "reply_to_post_feedback", arguments: { id: "p1", body: "On it" } });
    expect(calls.map((c) => `${c.method ?? "GET"} ${c.path}`)).toEqual([
      "PATCH /scheduled-posts/p1/approve",
      "GET /scheduled-posts/p1/proof-link",
      "GET /scheduled-posts/p1/review-comments",
      "POST /scheduled-posts/p1/review-comments",
    ]);
    expect(calls[3].body).toEqual({ body: "On it" });
  });

  it("create_review_link returns the link the client opens", async () => {
    respond = () => ({ id: "l1", token: "T".repeat(43), status: "active" });
    const client = await connect();
    const r = text(await client.callTool({ name: "create_review_link", arguments: { label: "Acme", expiresInDays: 14 } }));
    expect(r.url).toBe(`https://lazyrelay.com/review/${"T".repeat(43)}`);
    expect(calls[0].body).toEqual({ label: "Acme", expiresInDays: 14 });
  });
});

describe("list_scheduled_posts keeps an agent's context small", () => {
  const posts = [
    { id: "1", status: "pending", social_account_id: "ig", scheduled_for: "2026-10-01T09:00:00Z", content: "x".repeat(400), media_url: null, tags: ["a"], options: {}, changes_requested_at: null, post_results: [], SECRET_INTERNAL: "no" },
    { id: "2", status: "posted", social_account_id: "fb", scheduled_for: "2026-09-30T09:00:00Z", content: "Done", post_results: [{ verified_live: true, platform_post_url: "https://fb/1", error_message: null }] },
    { id: "3", status: "failed", social_account_id: "ig", scheduled_for: "2026-09-29T09:00:00Z", content: "Bad", post_results: [{ verified_live: false, platform_post_url: null, error_message: "TikTok declined this post." }] },
  ];
  it("gives a short summary, with confirmed-live and the problem, and never the raw internals", async () => {
    respond = () => posts;
    const client = await connect();
    const r = text(await client.callTool({ name: "list_scheduled_posts", arguments: {} }));
    expect(r.total).toBe(3);
    expect(r.posts[0].content.length).toBeLessThan(260);
    expect(r.posts[1]).toMatchObject({ verifiedLive: true, platformPostUrl: "https://fb/1", problem: null });
    expect(r.posts[2]).toMatchObject({ verifiedLive: false, problem: "TikTok declined this post." });
    expect(JSON.stringify(r)).not.toContain("SECRET_INTERNAL");
  });
  it("filters by status and account, limits, and can return full records", async () => {
    respond = () => posts;
    const client = await connect();
    expect(text(await client.callTool({ name: "list_scheduled_posts", arguments: { status: "failed" } })).posts.map((p: { id: string }) => p.id)).toEqual(["3"]);
    expect(text(await client.callTool({ name: "list_scheduled_posts", arguments: { socialAccountId: "ig" } })).total).toBe(2);
    expect(text(await client.callTool({ name: "list_scheduled_posts", arguments: { limit: 1 } })).total).toBe(1);
    expect(text(await client.callTool({ name: "list_scheduled_posts", arguments: { detail: true, status: "pending" } })).posts[0].SECRET_INTERNAL).toBe("no");
  });
});

describe("structured errors", () => {
  it("an API refusal becomes a machine-readable error with a hint an agent can act on", async () => {
    respond = () => {
      throw new LazyRelayApiError(400, "tiktokPrivacyLevel is required when posting to TikTok");
    };
    const client = await connect();
    const r = await client.callTool({ name: "schedule_post", arguments: { socialAccountId: "tt1", content: "x", scheduledFor: "2026-10-01T09:00:00Z" } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(text(r).error).toMatchObject({ kind: "validation", status: 400, retryable: false, hint: expect.stringContaining("get_tiktok_creator_info") });
  });

  it("classifies each kind of failure", () => {
    expect(describeApiError(403, "Your plan allows 1 active review link. Remove one or upgrade to add more.").kind).toBe("plan_limit");
    expect(describeApiError(403, "This API key isn't permitted to generate proof-sharing links.").kind).toBe("permission");
    expect(describeApiError(404, "Not found").kind).toBe("not_found");
    expect(describeApiError(409, "This post has already been scheduled.").kind).toBe("conflict");
    expect(describeApiError(429, "Too many requests")).toMatchObject({ kind: "rate_limited", retryable: true });
    expect(describeApiError(503, "down")).toMatchObject({ kind: "server", retryable: true });
    expect(describeApiError(401, "Invalid token").kind).toBe("auth");
    expect(describeApiError(400, "options.tiktok is not used by this platform").hint).toContain("get_platform_rules");
    expect(describeApiError(400, "boardId is required for Pinterest").hint).toContain("list_pinterest_boards");
    expect(describeApiError(400, "something odd").hint).toBeNull();
  });

  it("a non-API failure is still reported in the same shape, never thrown at the agent", async () => {
    respond = () => {
      throw new Error("network down");
    };
    const client = await connect();
    const r = await client.callTool({ name: "list_connected_accounts", arguments: {} });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(text(r).error).toMatchObject({ kind: "unknown", message: "network down" });
  });
});

describe("the request context reaches the server's call (how the hosted server finds the caller's token)", () => {
  it("passes the SDK's per-request extra to the call", async () => {
    const client = await connect();
    await client.callTool({ name: "list_workspaces", arguments: {} });
    expect(calls[0].extra).toBeTruthy();
  });
});

describe("documentation lists the same tools", () => {
  it("the dashboard and docs page list exactly the tools the server registers", () => {
    const docs = readFileSync(new URL("../../../frontend/src/lib/apiDocsContent.ts", import.meta.url), "utf8");
    const listed = [...docs.matchAll(/\{ name: "([a-z_]+)", summary:/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...LAZYRELAY_TOOL_NAMES].sort());
  });
  it("the local package README lists exactly the same tools", () => {
    const readme = readFileSync(new URL("../../../mcp-server/README.md", import.meta.url), "utf8");
    const listed = [...readme.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...LAZYRELAY_TOOL_NAMES].sort());
  });
});
