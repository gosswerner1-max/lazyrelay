// POST /referral/claim: keeps a partner code for a Google sign in. Signed in people only, never fails loudly over a bad code,
// and the account comes from the login, never from the body.
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const auth = vi.hoisted(() => ({ mode: "jwt" as "none" | "jwt" | "apiKey", accountId: "acc-1" }));
vi.mock("../auth.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../auth.js")>();
  return {
    ...real,
    requireAuth: (req: any, res: any, next: any) => {
      if (auth.mode === "none") {
        res.status(401).json({ error: "Missing or invalid credentials" });
        return;
      }
      req.authMethod = auth.mode;
      req.accountId = auth.accountId;
      if (auth.mode === "jwt") req.userId = "user-1";
      next();
    },
  };
});
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n(), publicRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t) } };
});

const { buildReferralClaimRouter } = await import("./referralClaim.routes.js");
const { tables } = await import("../../testFakeSupabase.js");

const app = (deps: object = {}) => {
  const a = express();
  a.use(express.json());
  a.use("/referral", buildReferralClaimRouter(deps as never));
  return a;
};

beforeEach(() => {
  auth.mode = "jwt";
  auth.accountId = "acc-1";
  vi.spyOn(console, "error").mockImplementation(() => {});
  tables.referral_partners = [{ id: "p1", code: "sarah", status: "approved" }];
  tables.accounts = [{ id: "acc-1", referred_by_code: null, referred_at: null, created_at: new Date().toISOString() }];
});

describe("POST /referral/claim", () => {
  it("needs a login and refuses an API key", async () => {
    auth.mode = "none";
    expect((await request(app()).post("/referral/claim").send({ code: "sarah" })).status).toBe(401);
    auth.mode = "apiKey";
    expect((await request(app()).post("/referral/claim").send({ code: "sarah" })).status).toBe(403);
  });

  it("sets the code on the signed in account when it has none", async () => {
    const res = await request(app()).post("/referral/claim").send({ code: "SARAH", accountId: "forged" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claimed: true });
    expect(tables.accounts[0].referred_by_code).toBe("sarah");
    expect(tables.accounts[0].referred_at).toEqual(expect.any(String));
  });

  it("never overwrites a code the account already has", async () => {
    tables.accounts[0].referred_by_code = "other";
    const res = await request(app()).post("/referral/claim").send({ code: "sarah" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claimed: false });
    expect(tables.accounts[0].referred_by_code).toBe("other");
  });

  it("ignores an account older than the 30 day attribution window", async () => {
    tables.accounts[0].created_at = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app()).post("/referral/claim").send({ code: "sarah" });
    expect(res.body).toEqual({ claimed: false });
    expect(tables.accounts[0].referred_by_code).toBeNull();
  });

  it("an unknown code or a malformed body is a quiet 200 with claimed false, never an error", async () => {
    for (const body of [{ code: "nobody" }, { code: 5 }, {}, { code: "x;drop" }]) {
      const res = await request(app()).post("/referral/claim").send(body);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ claimed: false });
    }
    expect(tables.accounts[0].referred_by_code).toBeNull();
  });

  it("a database failure is logged raw and still answers 200 claimed false", async () => {
    const res = await request(
      app({
        resolvePartnerCode: async () => {
          throw new Error("db down");
        },
      }),
    )
      .post("/referral/claim")
      .send({ code: "sarah" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claimed: false });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("referral claim"), expect.anything());
  });
});
