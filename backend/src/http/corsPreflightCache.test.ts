import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildApp } from "./app.js";
import { StubMorAdapter } from "../billing/stub.js";

// Browsers re-ask "may I call this?" (an OPTIONS preflight) before every API call unless the answer says how long
// it can be remembered. Without Access-Control-Max-Age Chrome remembers for 5 seconds, so every dashboard reload paid
// a full round trip for each of its API calls.
describe("CORS preflight cache", () => {
  it("tells the browser to remember the preflight answer", async () => {
    const app = buildApp(new StubMorAdapter(), new Map());
    const res = await request(app)
      .options("/api/social-accounts")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "authorization");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-max-age"]).toBe("7200");
  });

  it("still refuses an origin that is not allowed", async () => {
    const app = buildApp(new StubMorAdapter(), new Map());
    const res = await request(app)
      .options("/api/social-accounts")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "GET");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-max-age"]).toBeUndefined();
  });
});
