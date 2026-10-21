// POST /brands through the real route and the real checkBrandLimit: the per-plan brand caps from the 2026-10-20 pricing
// facts (free 1, pay as you go 2, Growth 4, Pro unlimited). Supabase is the in-memory fake; only the plan lookup is stubbed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables } from "../../testFakeSupabase.js";

const ctx = vi.hoisted(() => ({ tier: "free" as string }));

vi.mock("../auth.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return {
    requireAuth: (req: any, _res: any, next: any) => {
      req.accountId = "acc1";
      req.db = { from: (t: string) => f.makeBuilder(t) };
      next();
    },
  };
});
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t) } };
});
vi.mock("../../tier.js", () => ({ resolveTier: async () => ctx.tier }));

const { buildBrandsRouter } = await import("./brands.routes.js");
const { BRAND_LIMITS, UNLIMITED_BRANDS } = await import("../../brandLimits.js");

const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildBrandsRouter());
  return a;
};
const seed = (n: number) => {
  tables.brands = Array.from({ length: n }, (_, i) => ({ id: `b${i}`, account_id: "acc1", name: `Brand ${i}` }));
};
const create = (name: string) => request(app()).post("/brands").send({ name });

beforeEach(() => {
  tables.brands = [];
  tables.brand_addons = [];
  ctx.tier = "free";
});

describe("brand caps per plan", () => {
  it("the cap table matches the pricing facts", () => {
    expect(BRAND_LIMITS.free).toBe(1);
    expect(BRAND_LIMITS.payg).toBe(2);
    expect(BRAND_LIMITS.growth).toBe(4);
    expect(BRAND_LIMITS.lazy_pro).toBe(UNLIMITED_BRANDS);
  });

  it("free: first brand allowed, second refused", async () => {
    ctx.tier = "free";
    expect((await create("One")).status).toBe(201);
    expect((await create("Two")).status).toBe(403);
  });

  it("pay as you go: second brand allowed, third refused", async () => {
    ctx.tier = "payg";
    seed(1);
    expect((await create("Two")).status).toBe(201);
    expect((await create("Three")).status).toBe(403);
  });

  it("growth: the 4th brand is allowed and the 5th is refused", async () => {
    ctx.tier = "growth";
    seed(3);
    expect((await create("Fourth")).status).toBe(201);
    const fifth = await create("Fifth");
    expect(fifth.status).toBe(403);
    expect(fifth.body.error).toContain("limit of 4 brands");
    expect(tables.brands).toHaveLength(4);
  });

  it("pro: the 5th brand is allowed and so is the 50th", async () => {
    ctx.tier = "lazy_pro";
    seed(4);
    expect((await create("Fifth")).status).toBe(201);
    seed(49);
    expect((await create("Fiftieth")).status).toBe(201);
  });

  it("the refusal no longer offers a brand add-on to buy", async () => {
    ctx.tier = "growth";
    seed(4);
    const res = await create("Fifth");
    expect(res.status).toBe(403);
    expect(res.body.error.toLowerCase()).not.toContain("add-on");
  });

  it("an existing active brand add-on row is still honoured (grandfathered), never created here", async () => {
    ctx.tier = "growth";
    tables.brand_addons = [{ id: "a1", account_id: "acc1", status: "active" }];
    seed(4);
    expect((await create("Fifth")).status).toBe(201);
    expect((await create("Sixth")).status).toBe(403);
  });
});
