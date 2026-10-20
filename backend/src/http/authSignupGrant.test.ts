import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Response } from "express";

const getUser = vi.fn();
const trigger = vi.fn();

vi.mock("../supabase.js", () => ({
  supabase: {
    auth: { getUser: (...a: unknown[]) => getUser(...a), admin: { mfa: { listFactors: async () => ({ data: { factors: [] }, error: null }) } } },
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.not = async () => ({ data: [{ account_id: "a1", role: "owner" }], error: null });
      return q;
    },
  },
  createUserClient: () => ({}),
}));
vi.mock("./securityAlerts.js", () => ({ recordSecurityEvent: vi.fn() }));
vi.mock("../wallet/signupGrantHook.js", () => ({ triggerSignupGrant: (...a: unknown[]) => trigger(...a) }));

import { requireAuth, __resetVerifiedUserCacheForTests } from "./auth.js";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = `${b64({ alg: "HS256" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, aal: "aal1" })}.sig`;

async function run() {
  const req = { headers: { authorization: `Bearer ${token}` }, method: "GET", path: "/x" } as never;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
  const next = vi.fn();
  await requireAuth(req, res, next);
  return { next };
}

beforeEach(() => {
  __resetVerifiedUserCacheForTests();
  trigger.mockReset();
  getUser.mockReset();
  getUser.mockResolvedValue({ data: { user: { id: "u1", aud: "authenticated" } }, error: null });
});

describe("requireAuth: signup grant safety net", () => {
  it("asks for the signup grant for the resolved account on a dashboard login", async () => {
    const { next } = await run();
    expect(next).toHaveBeenCalledOnce();
    expect(trigger).toHaveBeenCalledWith("a1");
  });

  it("still lets the request through when the trigger throws synchronously", async () => {
    trigger.mockImplementation(() => { throw new Error("sync boom"); });
    const { next } = await run();
    expect(next).toHaveBeenCalledOnce();
  });

  it("still lets the request through when the trigger rejects", async () => {
    trigger.mockReturnValue(Promise.reject(new Error("async boom")));
    const { next } = await run();
    expect(next).toHaveBeenCalledOnce();
  });
});
