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
