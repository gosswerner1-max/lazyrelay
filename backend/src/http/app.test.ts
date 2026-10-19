import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildApp } from "./app.js";
import { StubMorAdapter } from "../billing/stub.js";

describe("GET /health/live", () => {
  it("returns 200 without touching the database", async () => {
    const app = buildApp(new StubMorAdapter(), new Map());
    const res = await request(app).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /health", () => {
  it("returns 200", async () => {
    const app = buildApp(new StubMorAdapter(), new Map());
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});

describe("content sources token routes are registered", () => {
  it("answer 404 while the flag is off and 401 without a login once it is on", async () => {
    const before = process.env.CONTENT_SOURCES_TOKENS_ENABLED;
    try {
      const app = buildApp(new StubMorAdapter(), new Map());
      process.env.CONTENT_SOURCES_TOKENS_ENABLED = "false";
      expect((await request(app).post("/api/content-sources/session")).status).toBe(404);
      process.env.CONTENT_SOURCES_TOKENS_ENABLED = "true";
      expect((await request(app).post("/api/content-sources/session")).status).toBe(401);
    } finally {
      if (before === undefined) delete process.env.CONTENT_SOURCES_TOKENS_ENABLED;
      else process.env.CONTENT_SOURCES_TOKENS_ENABLED = before;
    }
  });
});
