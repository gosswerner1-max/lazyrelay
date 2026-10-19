import { describe, expect, it, vi } from "vitest";
import { walletMode } from "./mode.js";
import { ENTERPRISE_MONTHLY_BUNDLE_MICRO, SIGNUP_GRANT_MICRO, enterpriseBundle, minActionPriceMicro, shouldPauseQueue, signupGrant } from "./rules.js";
import { fetchPausedAccountIds } from "./pause.js";
import { meterVerifiedDispatch } from "./meter.js";
import { WalletError, createWalletLedger, type WalletRpc } from "./ledger.js";
import { WalletValueError, microToUsd } from "./money.js";

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
  it("a Free Core account starts with a 0.50 USD allowance, once", () => {
    expect(SIGNUP_GRANT_MICRO).toBe(500_000);
    expect(microToUsd(SIGNUP_GRANT_MICRO)).toBe("0.5");
    expect(signupGrant(ACCOUNT)).toEqual({ amountMicro: 500_000, idempotencyKey: `signup-grant:${ACCOUNT}`, reference: "signup allowance", kind: "grant" });
    expect(signupGrant(ACCOUNT).idempotencyKey).toBe(signupGrant(ACCOUNT).idempotencyKey); // the same key every time: granted once
    expect(signupGrant(ACCOUNT).idempotencyKey).not.toBe(signupGrant(OTHER).idempotencyKey);
  });

  it("an Enterprise account gets 10 USD a month, keyed by subscription and billing period so a replayed webhook deposits once", () => {
    expect(ENTERPRISE_MONTHLY_BUNDLE_MICRO).toBe(10_000_000);
    const a = enterpriseBundle({ subscriptionId: "sub_01abc", periodStart: "2026-11-19T00:00:00Z" });
    expect(a).toEqual({ amountMicro: 10_000_000, idempotencyKey: "bundle:sub_01abc:2026-11-19", reference: "sub_01abc", kind: "grant" });
    expect(enterpriseBundle({ subscriptionId: "sub_01abc", periodStart: "2026-11-19T08:30:00Z" }).idempotencyKey).toBe(a.idempotencyKey); // same period, same key
    expect(enterpriseBundle({ subscriptionId: "sub_01abc", periodStart: "2026-12-19T00:00:00Z" }).idempotencyKey).not.toBe(a.idempotencyKey); // next month deposits again
  });

  it.each([["", "2026-11-19T00:00:00Z"], ["not a sub", "2026-11-19T00:00:00Z"], ["sub_01abc", "not a date"], ["sub_01abc", ""]])(
    "refuses a bundle for subscription %j and period %j",
    (subscriptionId, periodStart) => {
      expect(() => enterpriseBundle({ subscriptionId, periodStart })).toThrow(WalletValueError);
    },
  );

  it("refuses a bad account for the signup allowance", () => {
    expect(() => signupGrant("nope")).toThrow(WalletValueError);
  });
});

describe("the queue pauses when the wallet cannot pay for the next action", () => {
  it("the smallest action costs 0.002 USD", () => expect(minActionPriceMicro()).toBe(2000));

  it("pauses at zero and at any balance below the cheapest action, not at or above it", () => {
    expect(shouldPauseQueue(0)).toBe(true);
    expect(shouldPauseQueue(1999)).toBe(true);
    expect(shouldPauseQueue(2000)).toBe(false);
    expect(shouldPauseQueue(5_000_000)).toBe(false);
  });

  it("an account with NO wallet yet is never paused (so switching the wallet on cannot stop customers who were never given a balance)", () => {
    expect(shouldPauseQueue(null)).toBe(false);
  });

  it("refuses a negative or fractional balance", () => {
    for (const bad of [-1, 1.5, Number.NaN]) expect(() => shouldPauseQueue(bad)).toThrow(WalletValueError);
  });
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
    expect(rpc).toHaveBeenCalledWith("wallet_paused_account_ids", { p_min: 2000 });
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
const POST = { postId: "11111111-1111-4111-8111-111111111111", platform: "mastodon", accountId: ACCOUNT };

describe("charging a verified dispatch", () => {
  it("off: nothing happens", async () => {
    const { ledger, calls } = ledgerWith(() => ({ ok: true, replay: false, charged_micro: 2000, balance_micro: 1 }));
    expect(await meterVerifiedDispatch({ ledger, mode: "off", post: POST, log: () => undefined })).toEqual({ outcome: "off" });
    expect(calls).toEqual([]);
  });

  it("shadow: it says what it would charge and charges nothing", async () => {
    const { ledger, calls } = ledgerWith(() => ({ ok: true, replay: false, charged_micro: 2000, balance_micro: 1 }));
    const log = vi.fn();
    expect(await meterVerifiedDispatch({ ledger, mode: "shadow", post: POST, log })).toEqual({ outcome: "would_charge", chargedMicro: 2000 });
    expect(calls).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("0.002"));
  });

  it("on: charges exactly one api_dispatch with a key built from the post and the platform", async () => {
    const { ledger, calls } = ledgerWith(() => ({ ok: true, replay: false, charged_micro: 2000, balance_micro: 498_000 }));
    expect(await meterVerifiedDispatch({ ledger, mode: "on", post: POST, log: () => undefined })).toEqual({ outcome: "charged", chargedMicro: 2000, balanceMicro: 498_000 });
    expect(calls).toEqual([{ fn: "wallet_charge", args: { p_account_id: ACCOUNT, p_action: "api_dispatch", p_units: 1, p_key: `dispatch:${POST.postId}:mastodon` } }]);
  });

  it("on: a retried post is a replay, not a second charge", async () => {
    const { ledger } = ledgerWith(() => ({ ok: true, replay: true, charged_micro: 2000, balance_micro: 498_000 }));
    expect(await meterVerifiedDispatch({ ledger, mode: "on", post: POST, log: () => undefined })).toMatchObject({ outcome: "replay" });
  });

  it("on: an empty wallet is reported, never thrown (the post is already live; the pause stops the NEXT ones)", async () => {
    const { ledger } = ledgerWith(() => ({ ok: false, reason: "insufficient_funds", balance_micro: 0, required_micro: 2000 }));
    expect(await meterVerifiedDispatch({ ledger, mode: "on", post: POST, log: () => undefined })).toEqual({ outcome: "insufficient_funds", balanceMicro: 0 });
  });

  it("on: a wallet failure never throws into the publisher; it is logged with no database text", async () => {
    const { ledger } = ledgerWith(() => null, { message: "boom 10.0.0.5 secret_role" });
    const log = vi.fn();
    expect(await meterVerifiedDispatch({ ledger, mode: "on", post: POST, log })).toEqual({ outcome: "error" });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/10\.0\.0\.5|secret_role/);
  });

  it("refuses a post it cannot key (no platform, bad ids) without calling the wallet", async () => {
    const { ledger, calls } = ledgerWith(() => ({ ok: true, replay: false, charged_micro: 2000, balance_micro: 1 }));
    for (const post of [{ ...POST, platform: "" }, { ...POST, postId: "nope" }, { ...POST, accountId: "nope" }]) {
      expect(await meterVerifiedDispatch({ ledger, mode: "on", post, log: () => undefined })).toEqual({ outcome: "error" });
    }
    expect(calls).toEqual([]);
    void WalletError;
  });
});

import { GRANDFATHERING, isGrandfathered } from "./plans.proposal.js";

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
    expect(await ledger.charge({ accountId: ACCOUNT, action: "api_dispatch", idempotencyKey: "k" })).toEqual({ ok: true, replay: false, exempt: true, chargedMicro: 0, balanceMicro: 0 });
  });

  it("an exempt answer that claims a charge is refused as a bad answer", async () => {
    const { ledger } = ledgerWith(() => ({ ok: true, replay: false, exempt: true, charged_micro: 2000, balance_micro: 0 }));
    await expect(ledger.charge({ accountId: ACCOUNT, action: "api_dispatch", idempotencyKey: "k" })).rejects.toThrow(WalletError);
  });

  it("metering reports a grandfathered account as exempt and charges nothing", async () => {
    const { ledger } = ledgerWith(() => ({ ok: true, replay: false, exempt: true, charged_micro: 0, balance_micro: 0 }));
    expect(await meterVerifiedDispatch({ ledger, mode: "on", post: POST, log: () => undefined })).toEqual({ outcome: "exempt" });
  });
});
