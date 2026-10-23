import { describe, expect, it, vi } from "vitest";
import { walletMode } from "./mode.js";
import { minActionPriceMicro, signupGrant } from "./rules.js";
import { fetchPausedAccountIds } from "./pause.js";
import { WalletError, createWalletLedger, type WalletRpc } from "./ledger.js";
import { WalletValueError } from "./money.js";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("the switch has three positions", () => {
  it("off unless WALLET_ENABLED is exactly true", () => {
    for (const env of [{}, { WALLET_ENABLED: "TRUE" }, { WALLET_ENABLED: "1" }, { WALLET_MODE: "on" }, { WALLET_ENABLED: "false", WALLET_MODE: "on" }]) {
      expect(walletMode(env), JSON.stringify(env)).toBe("off");
    }
  });
  it("shadow when enabled and WALLET_MODE is anything but exactly on (a typo can never charge anyone)", () => {
    for (const mode of [undefined, "", "shadow", "ON", "On", "true", "yes", "on "]) expect(walletMode({ WALLET_ENABLED: "true", WALLET_MODE: mode }), String(mode)).toBe("shadow");
  });
  it("on only when enabled and WALLET_MODE is exactly on", () => {
    expect(walletMode({ WALLET_ENABLED: "true", WALLET_MODE: "on" })).toBe("on");
  });
});

describe("the credit rules", () => {
  it("a Free account starts with 30 credits, once, with no expiry", () => {
    expect(signupGrant(ACCOUNT)).toEqual({ kind: "signup", credits: 30, expiresAt: null, sourceKey: `signup:${ACCOUNT}` });
    expect(signupGrant(ACCOUNT).sourceKey).toBe(signupGrant(ACCOUNT).sourceKey); // the same key every time: granted once
    expect(signupGrant(ACCOUNT).sourceKey).not.toBe(signupGrant(OTHER).sourceKey);
  });

  it("refuses a bad account for the signup allowance", () => {
    expect(() => signupGrant("nope")).toThrow(WalletValueError);
  });
});

describe("the queue pauses when the wallet cannot pay for the next action", () => {
  it("the smallest action costs 1 credit", () => expect(minActionPriceMicro()).toBe(1_000_000));
});


function pausedRpc(data: unknown, error: { message: string } | null = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  return { client: { rpc } as unknown as WalletRpc, rpc };
}

describe("which accounts the publisher must leave alone", () => {
  it("off: nobody is paused and the database is not even asked", async () => {
    const { client, rpc } = pausedRpc([{ wallet_paused_account_ids: ACCOUNT }]);
    expect(await fetchPausedAccountIds(client, "off", () => undefined)).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("shadow: nobody is paused, but it is logged how many would have been", async () => {
    const { client } = pausedRpc([ACCOUNT, OTHER]);
    const log = vi.fn();
    expect(await fetchPausedAccountIds(client, "shadow", log)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("2"));
  });

  it("on: returns the accounts the database lists", async () => {
    const { client, rpc } = pausedRpc([ACCOUNT, OTHER]);
    expect(await fetchPausedAccountIds(client, "on", () => undefined)).toEqual([ACCOUNT, OTHER]);
    expect(rpc).toHaveBeenCalledWith("wallet_paused_account_ids", { p_min: 1_000_000 });
  });

  it("on: also reads the shape Supabase uses for a function returning a set of uuids", async () => {
    const { client } = pausedRpc([{ wallet_paused_account_ids: ACCOUNT }]);
    expect(await fetchPausedAccountIds(client, "on", () => undefined)).toEqual([ACCOUNT]);
  });

  it("on: if the wallet cannot be read nobody is paused (publishing must never stop because the wallet is down)", async () => {
    const log = vi.fn();
    expect(await fetchPausedAccountIds(pausedRpc(null, { message: "down" }).client, "on", log)).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  it("on: a malformed answer pauses nobody and an id that is not a uuid is dropped, so it can never reach a query", async () => {
    expect(await fetchPausedAccountIds(pausedRpc("garbage").client, "on", () => undefined)).toEqual([]);
    expect(await fetchPausedAccountIds(pausedRpc([ACCOUNT, "1); drop table x; --"]).client, "on", () => undefined)).toEqual([ACCOUNT]);
  });
});

function ledgerWith(answer: () => unknown, error?: { message: string; code?: string }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: WalletRpc = {
    async rpc(fn, args) {
      calls.push({ fn, args });
      return { data: error ? null : answer(), error: error ?? null };
    },
  };
  return { ledger: createWalletLedger(client), calls };
}
import { GRANDFATHERING, isGrandfathered } from "./grandfathering.js";

describe("grandfathered accounts (owner decision 2026-10-19)", () => {
  it("every account that exists at the cutoff keeps its price and limits and is never metered or paused", () => {
    expect(GRANDFATHERING).toMatchObject({
      keepsPriceAndLimits: true,
      walletMetering: false,
      walletPause: false,
      paddlePricesStayActive: true,
      closedToNewBuyers: ["starter", "pro", "business", "agency", "agency_plus"],
    });
    expect(GRANDFATHERING.newModelAppliesTo).toMatch(/created on or after the cutoff/);
  });

  it("an account created BEFORE the cutoff is grandfathered; one created on or after it is not", () => {
    const cutoff = "2026-10-20T00:00:00Z";
    expect(isGrandfathered("2026-10-19T23:59:59Z", cutoff)).toBe(true);
    expect(isGrandfathered("2026-01-01T00:00:00Z", cutoff)).toBe(true);
    expect(isGrandfathered("2026-10-20T00:00:00Z", cutoff)).toBe(false);
    expect(isGrandfathered("2026-11-01T00:00:00Z", cutoff)).toBe(false);
    expect(isGrandfathered(new Date("2026-10-19T00:00:00Z"), new Date(cutoff))).toBe(true);
  });

  it("refuses dates it cannot read, so a bad value can never exempt (or meter) someone by accident", () => {
    expect(() => isGrandfathered("not a date", "2026-10-20T00:00:00Z")).toThrow(WalletValueError);
    expect(() => isGrandfathered("2026-10-19T00:00:00Z", "")).toThrow(WalletValueError);
  });

  it("the ledger client understands the exempt answer: a charge of zero, no balance change", async () => {
    const { ledger } = ledgerWith(() => ({ ok: true, replay: false, exempt: true, charged_micro: 0, balance_micro: 0 }));
    expect(await ledger.charge({ accountId: ACCOUNT, action: "post_publish", idempotencyKey: "k" })).toEqual({ ok: true, replay: false, exempt: true, chargedMicro: 0, balanceMicro: 0 });
  });

  it("an exempt answer that claims a charge is refused as a bad answer", async () => {
    const { ledger } = ledgerWith(() => ({ ok: true, replay: false, exempt: true, charged_micro: 1_000_000, balance_micro: 0 }));
    await expect(ledger.charge({ accountId: ACCOUNT, action: "post_publish", idempotencyKey: "k" })).rejects.toThrow(WalletError);
  });
});
