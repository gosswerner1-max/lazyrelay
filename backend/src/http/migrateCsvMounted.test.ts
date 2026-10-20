// POST /api/migrate/csv on the REAL app: the dark-route flag, the sign-in requirement and the 2 MB parser that is mounted
// ahead of the global (100 KB) JSON parser. Nothing here needs a database.

import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  return {
    supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: null, error: null }), auth: { getUser: async () => ({ data: { user: null }, error: { message: "no" } }) } },
    createUserClient: () => ({}),
  };
});

const buildTestApp = async () => {
  const { buildApp } = await import("./app.js");
  const { StubMorAdapter } = await import("../billing/stub.js");
  return buildApp(new StubMorAdapter(), new Map());
};

afterEach(() => {
  delete process.env.CSV_MIGRATION_ENABLED;
});

describe("POST /api/migrate/csv is mounted on the real app", () => {
  it("is a dark route: 404 with the JSON not-found answer while the flag is off", async () => {
    const app = await buildTestApp();
    const res = await request(app).post("/api/migrate/csv").send({ csv: "Text\nhi\n" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  }, 30_000);

  it("needs a signed-in user once the flag is on", async () => {
    process.env.CSV_MIGRATION_ENABLED = "true";
    const app = await buildTestApp();
    const res = await request(app).post("/api/migrate/csv").send({ csv: "Text\nhi\n" });
    expect(res.status).toBe(401);
  }, 30_000);

  it("reads a JSON body well over the global 100 KB limit (up to 2 MB) before it checks the sign-in", async () => {
    process.env.CSV_MIGRATION_ENABLED = "true";
    const app = await buildTestApp();
    const res = await request(app).post("/api/migrate/csv").send({ csv: "a".repeat(300_000) });
    expect(res.status).toBe(401);
  }, 30_000);
});
