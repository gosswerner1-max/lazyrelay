// Saved snippets API: validation, per-account isolation, the 50-snippet limit and
// the single signature. Login is mocked; supabase is an in-memory fake.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables } from "../../testFakeSupabase.js";

const auth = vi.hoisted(() => ({ accountId: "acc1" }));
vi.mock("../auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.accountId = auth.accountId;
    next();
  },
}));
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_req: any, _res: any, next: any) => next() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: null, error: null }) } };
});

const { buildSnippetsRouter, MAX_SNIPPETS } = await import("./snippets.routes.js");
const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildSnippetsRouter());
  return a;
};

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  auth.accountId = "acc1";
});

const add = (body: Record<string, unknown>) => request(app()).post("/snippets").send(body);

describe("snippets API", () => {
  it("adds and lists a snippet", async () => {
    const res = await add({ name: "  Hashtags  ", content: "  #social #scheduling  " });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Hashtags", content: "#social #scheduling", isSignature: false });
    const list = await request(app()).get("/snippets");
    expect(list.body.snippets).toHaveLength(1);
    expect(list.body.maxSnippets).toBe(MAX_SNIPPETS);
  });

  it("refuses an empty name or content, and text that is too long", async () => {
    expect((await add({ name: "", content: "x" })).status).toBe(400);
    expect((await add({ name: "x", content: "   " })).status).toBe(400);
    const long = await add({ name: "x", content: "a".repeat(2001) });
    expect(long.status).toBe(400);
    expect(long.body.error).toMatch(/2000 characters/);
    expect(tables.saved_snippets ?? []).toHaveLength(0);
  });

  it("only one snippet can be the signature: a new signature takes over", async () => {
    const a = (await add({ name: "First", content: "one", isSignature: true })).body;
    const b = (await add({ name: "Second", content: "two", isSignature: true })).body;
    const sigs = (await request(app()).get("/snippets")).body.snippets.filter((s: { isSignature: boolean }) => s.isSignature);
    expect(sigs.map((s: { id: string }) => s.id)).toEqual([b.id]);
    expect(a.id).not.toBe(b.id);
    // Editing the first one to be the signature moves it back.
    await request(app()).patch(`/snippets/${a.id}`).send({ isSignature: true });
    const after = (await request(app()).get("/snippets")).body.snippets.filter((s: { isSignature: boolean }) => s.isSignature);
    expect(after.map((s: { id: string }) => s.id)).toEqual([a.id]);
  });

  it("edits and deletes", async () => {
    const s = (await add({ name: "A", content: "one" })).body;
    const edited = await request(app()).patch(`/snippets/${s.id}`).send({ content: "changed" });
    expect(edited.body.content).toBe("changed");
    expect((await request(app()).delete(`/snippets/${s.id}`)).body).toEqual({ deleted: true });
    expect((await request(app()).get("/snippets")).body.snippets).toHaveLength(0);
  });

  it("stops at the limit, counting only this account", async () => {
    tables.saved_snippets = Array.from({ length: MAX_SNIPPETS }, (_, i) => ({ id: `s${i}`, account_id: "acc1", name: "n", content: "c", is_signature: false, created_at: new Date().toISOString() }));
    const blocked = await add({ name: "one more", content: "x" });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/up to 50/);
    auth.accountId = "acc2";
    expect((await add({ name: "other account", content: "x" })).status).toBe(201);
  });

  it("never shows or touches another account's snippets", async () => {
    tables.saved_snippets = [{ id: "theirs", account_id: "acc2", name: "secret", content: "private", is_signature: true, created_at: new Date().toISOString() }];
    expect((await request(app()).get("/snippets")).body.snippets).toHaveLength(0);
    expect((await request(app()).patch("/snippets/theirs").send({ name: "mine now" })).status).toBe(404);
    expect((await request(app()).delete("/snippets/theirs")).status).toBe(404);
    expect(tables.saved_snippets[0]).toMatchObject({ name: "secret", is_signature: true });
  });
});
