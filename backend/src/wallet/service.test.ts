import { describe, it, expect, vi } from "vitest";
import { createWalletService, type LotRow, type WalletServiceDeps } from "./service.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-20T10:00:00.000Z");

function deps(over: Partial<WalletServiceDeps> = {}) {
  const grant = vi.fn(async (i: { accountId: string; kind: "signup" | "pack"; credits: number; sourceKey: string }) => ({
    ok: true as const, replay: false, lotId: "22222222-2222-4222-8222-222222222222", grantedMicro: i.credits * 1_000_000, balanceMicro: i.credits * 1_000_000,
  }));
  const balance = vi.fn(async () => ({ spendableMicro: 0, heldMicro: 0, nextExpiryAt: null as string | null, nextExpiryMicro: null as number | null }));
  const d: WalletServiceDeps = {
    ledger: { grant, balance },
    readLots: async () => ({ lots: [], activeHolds: 0 }),
    isLegacy: async () => false,
    isEmailConfirmed: async () => true,
    now: () => NOW,
    ...over,
  };
  return { d, grant, balance };
}

describe("getBalance", () => {
  it("splits spendable micro credits by lot kind and ignores expired lots", async () => {
    const lots: LotRow[] = [
      { kind: "signup", remainingMicro: 30_000_000, reservedMicro: 0, expiresAt: null },
      { kind: "pack", remainingMicro: 290_000_000, reservedMicro: 10_000_000, expiresAt: null },
      { kind: "subscription", remainingMicro: 1_000_000_000, reservedMicro: 0, expiresAt: "2026-10-19T00:00:00.000Z" }, // already expired
      { kind: "subscription", remainingMicro: 500_000_000, reservedMicro: 0, expiresAt: "2026-11-01T00:00:00.000Z" },
    ];
    const { d } = deps({
      readLots: async () => ({ lots, activeHolds: 1 }),
      ledger: {
        grant: vi.fn(),
        balance: async () => ({ spendableMicro: 810_000_000, heldMicro: 10_000_000, nextExpiryAt: "2026-11-01T00:00:00.000Z", nextExpiryMicro: 500_000_000 }),
      },
    });
    const b = await createWalletService(d).getBalance(ACCOUNT);
    expect(b.byKindMicro).toEqual({ signup: 30_000_000, pack: 280_000_000, subscription: 500_000_000 });
    expect(b.spendableMicro).toBe(810_000_000);
    expect(b.displayCredits).toBe("810");
    expect(b.heldMicro).toBe(10_000_000);
    expect(b.heldCredits).toBe("10");
    expect(b.activeHolds).toBe(1);
    expect(b.nextExpiryAt).toBe("2026-11-01T00:00:00.000Z");
    expect(b.nextExpiryCredits).toBe("500");
  });

  it("shows half credits and an empty wallet without inventing an expiry", async () => {
    const { d } = deps({ ledger: { grant: vi.fn(), balance: async () => ({ spendableMicro: 500_000, heldMicro: 0, nextExpiryAt: null, nextExpiryMicro: null }) } });
    const b = await createWalletService(d).getBalance(ACCOUNT);
    expect(b.displayCredits).toBe("0.5");
    expect(b.nextExpiryAt).toBeNull();
    expect(b.nextExpiryCredits).toBeNull();
    expect(b.byKindMicro).toEqual({ signup: 0, pack: 0, subscription: 0 });
  });
});

describe("ensureSignupGrant", () => {
  it("grants the 30 credit signup lot with the key signup:{accountId} once the email is confirmed", async () => {
    const { d, grant } = deps();
    const r = await createWalletService(d).ensureSignupGrant(ACCOUNT);
    expect(r).toEqual({ granted: true, reason: "granted" });
    expect(grant).toHaveBeenCalledWith({ accountId: ACCOUNT, kind: "signup", credits: 30, sourceKey: `signup:${ACCOUNT}` });
  });

  it("does nothing while the email is unconfirmed", async () => {
    const { d, grant } = deps({ isEmailConfirmed: async () => false });
    expect(await createWalletService(d).ensureSignupGrant(ACCOUNT)).toEqual({ granted: false, reason: "email_unconfirmed" });
    expect(grant).not.toHaveBeenCalled();
  });

  it("skips legacy accounts without even checking the email", async () => {
    const isEmailConfirmed = vi.fn(async () => true);
    const { d, grant } = deps({ isLegacy: async () => true, isEmailConfirmed });
    expect(await createWalletService(d).ensureSignupGrant(ACCOUNT)).toEqual({ granted: false, reason: "legacy" });
    expect(grant).not.toHaveBeenCalled();
    expect(isEmailConfirmed).not.toHaveBeenCalled();
  });

  it("is idempotent: a second call reuses the same key and reports a replay, never a second grant", async () => {
    const seen = new Set<string>();
    const grant = vi.fn(async (i: { sourceKey: string; credits: number }) => {
      const replay = seen.has(i.sourceKey);
      seen.add(i.sourceKey);
      return { ok: true as const, replay, lotId: "22222222-2222-4222-8222-222222222222", grantedMicro: 30_000_000, balanceMicro: 30_000_000 };
    });
    const { d } = deps({ ledger: { grant: grant as never, balance: vi.fn() } });
    const svc = createWalletService(d);
    expect(await svc.ensureSignupGrant(ACCOUNT)).toEqual({ granted: true, reason: "granted" });
    expect(await svc.ensureSignupGrant(ACCOUNT)).toEqual({ granted: false, reason: "replay" });
    expect(grant.mock.calls.map((c) => c[0].sourceKey)).toEqual([`signup:${ACCOUNT}`, `signup:${ACCOUNT}`]);
  });

  it("lets a ledger failure surface instead of swallowing it", async () => {
    const { d } = deps({ ledger: { grant: vi.fn(async () => { throw new Error("wallet down"); }), balance: vi.fn() } });
    await expect(createWalletService(d).ensureSignupGrant(ACCOUNT)).rejects.toThrow("wallet down");
  });
});
