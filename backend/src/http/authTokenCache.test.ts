import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Response } from "express";

const getUser = vi.fn();
const listFactors = vi.fn();
const membershipRows = vi.fn();

vi.mock("../supabase.js", () => ({
  supabase: {
    auth: {
      getUser: (...a: unknown[]) => getUser(...a),
      admin: { mfa: { listFactors: (...a: unknown[]) => listFactors(...a) } },
    },
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.not = () => membershipRows();
      return q;
    },
  },
  createUserClient: () => ({}),
}));
vi.mock("./securityAlerts.js", () => ({ recordSecurityEvent: vi.fn() }));

import {
  requireAuth,
  __resetVerifiedUserCacheForTests,
  __verifiedUserCacheKeysForTests,
  VERIFIED_USER_CACHE_TTL_MS,
  VERIFIED_USER_CACHE_MAX,
} from "./auth.js";

function makeToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}
const nowSec = () => Math.floor(Date.now() / 1000);

async function run(token: string) {
  const req = { headers: { authorization: `Bearer ${token}` }, method: "GET", path: "/x" } as never;
  const status = vi.fn().mockReturnThis();
  const res = { status, json: vi.fn().mockReturnThis() } as unknown as Response;
  const next = vi.fn();
  await requireAuth(req, res, next);
  return { res, status, next };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
  __resetVerifiedUserCacheForTests();
  getUser.mockReset();
  listFactors.mockReset();
  membershipRows.mockReset();
  getUser.mockResolvedValue({ data: { user: { id: "u1", aud: "authenticated" } }, error: null });
  listFactors.mockResolvedValue({ data: { factors: [] }, error: null });
  membershipRows.mockResolvedValue({ data: [{ account_id: "a1", role: "owner" }], error: null });
});
afterEach(() => vi.useRealTimers());

describe("requireAuth: one Supabase identity check per token", () => {
  it("asks Supabase who the token belongs to only once for repeated requests", async () => {
    const token = makeToken({ exp: nowSec() + 3600, aal: "aal1" });
    for (let i = 0; i < 5; i++) {
      const { next } = await run(token);
      expect(next).toHaveBeenCalledOnce();
    }
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("still checks MFA on every request (never cached)", async () => {
    const token = makeToken({ exp: nowSec() + 3600, aal: "aal1" });
    await run(token);
    await run(token);
    expect(listFactors).toHaveBeenCalledTimes(2);
  });

  it("denies an aal1 token the moment an MFA factor exists, even on a cache hit", async () => {
    const token = makeToken({ exp: nowSec() + 3600, aal: "aal1" });
    await run(token);
    listFactors.mockResolvedValue({ data: { factors: [{ status: "verified" }] }, error: null });
    const { status, next } = await run(token);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it("fails closed when the MFA lookup errors", async () => {
    const token = makeToken({ exp: nowSec() + 3600, aal: "aal2" });
    listFactors.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(run(token)).rejects.toBeDefined();
  });

  it("still denies a user with no membership", async () => {
    const token = makeToken({ exp: nowSec() + 3600 });
    membershipRows.mockResolvedValue({ data: [], error: null });
    const { status, next } = await run(token);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it("re-checks with Supabase after the TTL", async () => {
    const token = makeToken({ exp: nowSec() + 3600 });
    await run(token);
    vi.advanceTimersByTime(VERIFIED_USER_CACHE_TTL_MS + 1);
    await run(token);
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it("never serves a cached answer past the token's own expiry", async () => {
    const token = makeToken({ exp: nowSec() + 5 }); // expires well inside the TTL
    await run(token);
    vi.advanceTimersByTime(6000);
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "expired" } });
    const { status, next } = await run(token);
    expect(getUser).toHaveBeenCalledTimes(2);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it("does not cache failures", async () => {
    const token = makeToken({ exp: nowSec() + 3600 });
    getUser.mockResolvedValueOnce({ data: { user: null }, error: { message: "bad" } });
    const first = await run(token);
    expect(first.next).not.toHaveBeenCalled();
    const second = await run(token);
    expect(second.next).toHaveBeenCalledOnce();
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it("does not cache a token without a usable exp claim", async () => {
    const token = makeToken({ aal: "aal1" });
    await run(token);
    await run(token);
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it("keeps different tokens apart", async () => {
    await run(makeToken({ exp: nowSec() + 3600, n: 1 }));
    await run(makeToken({ exp: nowSec() + 3600, n: 2 }));
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it("stays bounded in size", async () => {
    for (let i = 0; i < VERIFIED_USER_CACHE_MAX + 20; i++) await run(makeToken({ exp: nowSec() + 3600, n: i }));
    expect(__verifiedUserCacheKeysForTests().length).toBeLessThanOrEqual(VERIFIED_USER_CACHE_MAX);
    getUser.mockClear();
    await run(makeToken({ exp: nowSec() + 3600, n: 0 })); // oldest was evicted, so Supabase is asked again
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("does not store the raw token", async () => {
    const token = makeToken({ exp: nowSec() + 3600, marker: "RAWTOKENMARKER" });
    await run(token);
    const keys = __verifiedUserCacheKeysForTests();
    expect(keys.length).toBe(1);
    expect(keys[0]).not.toContain(token);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});
