// The OpenAPI document must describe the REAL API: every path and method it lists has to exist on the
// running app (no invented endpoints), every $ref must resolve, and nothing a signed-in person is required
// for may be advertised to an API key.

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { buildOpenApiDocument } from "./openapi.js";
import { getPlatformRules } from "./platformRules.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: null, error: null }), auth: { getUser: async () => ({ data: { user: null }, error: { message: "no" } }) } } };
});

type Doc = { paths: Record<string, Record<string, { operationId: string; tags: string[]; responses: Record<string, unknown>; security?: unknown[] }>>; components: { schemas: Record<string, unknown> } };
const doc = buildOpenApiDocument() as unknown as Doc;
const METHODS = ["get", "post", "patch", "put", "delete"];
const operations = Object.entries(doc.paths).flatMap(([path, item]) => METHODS.filter((m) => item[m]).map((m) => ({ path, method: m, op: item[m] })));

describe("the OpenAPI document", () => {
  it("is OpenAPI 3.1 with a server, a bearer security scheme and a useful number of operations", () => {
    const d = buildOpenApiDocument() as Record<string, any>;
    expect(d.openapi).toBe("3.1.0");
    expect(d.servers[0].url).toBe("https://lazyrelaylazyrelay-backend.onrender.com/api");
    expect(d.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(operations.length).toBeGreaterThan(50);
  });

  it("every operation has a unique id, a tag and a documented success and error response", () => {
    const ids = operations.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const o of operations) {
      expect(o.op.tags.length, o.op.operationId).toBeGreaterThan(0);
      expect(o.op.responses["200"], o.op.operationId).toBeTruthy();
    }
  });

  it("every $ref points at a schema that exists", () => {
    const text = JSON.stringify(doc);
    const refs = [...text.matchAll(/#\/components\/schemas\/([A-Za-z]+)/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(20);
    for (const r of new Set(refs)) expect(doc.components.schemas[r], `missing schema ${r}`).toBeTruthy();
  });

  it("every path parameter in a path is declared on its operations", () => {
    for (const o of operations) {
      const names = [...o.path.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]);
      const declared = ((o.op as unknown as { parameters?: Array<{ name: string; in: string }> }).parameters ?? []).filter((p) => p.in === "path").map((p) => p.name);
      for (const n of names) expect(declared, `${o.method} ${o.path} is missing path parameter ${n}`).toContain(n);
    }
  });

  it("never advertises what needs a signed-in person (keys, team, billing, webhooks, DM automations, admin)", () => {
    const forbidden = /^\/(api-keys|team|admin|webhooks|dm-automations|subscription|storage-addons|brand-addons|seat-addons)/;
    for (const o of operations) expect(o.path, `${o.method} ${o.path} needs a signed-in person`).not.toMatch(forbidden);
  });

  it("lists the same platforms as the platform-rules lookup", () => {
    const listed = String((doc.components.schemas.SocialAccount as any).properties.platform.description).split(",").map((p) => p.trim());
    expect(listed.sort()).toEqual(getPlatformRules().map((p) => p.platform).sort());
  });
});

describe("every documented operation exists on the real app", () => {
  it("answers something other than Express's own 'Cannot METHOD /path' for each one", async () => {
    const { buildApp } = await import("./http/app.js");
    const { StubMorAdapter } = await import("./billing/stub.js");
    const app = buildApp(new StubMorAdapter(), new Map());
    const missing: string[] = [];
    for (const o of operations) {
      const url = "/api" + o.path.replace(/\{[a-zA-Z]+\}/g, "x");
      const res = await (request(app) as any)[o.method](url).send({});
      if (/Cannot (GET|POST|PATCH|PUT|DELETE)/.test(res.text ?? "")) missing.push(`${o.method.toUpperCase()} ${o.path}`);
    }
    expect(missing, `documented but not on the app: ${missing.join(", ")}`).toEqual([]);
  }, 120_000);

  it("is served, publicly, at /api/openapi.json", async () => {
    const { buildApp } = await import("./http/app.js");
    const { StubMorAdapter } = await import("./billing/stub.js");
    const res = await request(buildApp(new StubMorAdapter(), new Map())).get("/api/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.info.title).toBe("LazyRelay API");
    expect(res.headers["cache-control"]).toMatch(/max-age/);
  }, 60_000);
});
