import { describe, expect, it } from "vitest";
import { MICRO_PER_CREDIT, MICRO_PER_USD, WalletValueError, assertPositiveMicro, creditsToMicro, microToCredits, microToUsd, minorUnitsToMicro, usdToPositiveMicro } from "./money.js";
import { WALLET_PRICES_MICRO } from "./prices.js";
import { walletEnabled } from "./flags.js";

describe("money: whole micro dollars, never floating point", () => {
  it("1 USD is 1,000,000 micro", () => expect(MICRO_PER_USD).toBe(1_000_000));

  it.each([
    ["0.002", 2000],
    ["0.05", 50_000],
    ["5", 5_000_000],
    ["12.345678", 12_345_678],
    ["0.000001", 1],
  ])("reads the decimal string %s as %i micro exactly", (text, micro) => expect(usdToPositiveMicro(text)).toBe(micro));

  it.each(["0", "0.0", "0.000000", "-1", "-0.002", "+1", "1e3", "1,5", " 1", "1 ", "", "abc", "0.0000001", "1.", ".5", "NaN", "Infinity", "1000000000000"])(
    "refuses %j (zero, negative, odd formats, more than 6 decimals, over the cap)",
    (text) => expect(() => usdToPositiveMicro(text)).toThrow(WalletValueError),
  );

  it("refuses a JavaScript number, so a float can never be used as money", () => {
    expect(() => usdToPositiveMicro(0.002 as unknown as string)).toThrow(WalletValueError);
  });

  it("formats micro back as a minimal decimal string", () => {
    expect(microToUsd(2000)).toBe("0.002");
    expect(microToUsd(50_000)).toBe("0.05");
    expect(microToUsd(5_000_000)).toBe("5");
    expect(microToUsd(1)).toBe("0.000001");
    expect(microToUsd(0)).toBe("0");
  });

  it("round trips every price", () => {
    for (const micro of Object.values(WALLET_PRICES_MICRO)) expect(usdToPositiveMicro(microToUsd(micro))).toBe(micro);
  });

  it("assertPositiveMicro accepts only whole positive safe numbers up to 1,000,000,000,000", () => {
    expect(assertPositiveMicro(1)).toBe(1);
    expect(assertPositiveMicro(1_000_000_000_000)).toBe(1_000_000_000_000);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_000_001, "5", null, undefined, 2 ** 60]) expect(() => assertPositiveMicro(bad), String(bad)).toThrow(WalletValueError);
  });

  it("Paddle amounts are in the smallest currency unit: 500 means 5.00 USD, which is 5,000,000 micro", () => {
    expect(minorUnitsToMicro("500")).toBe(5_000_000);
    expect(minorUnitsToMicro("1")).toBe(10_000);
    for (const bad of ["0", "-500", "5.00", "1e3", "", " 500", "abc"]) expect(() => minorUnitsToMicro(bad), bad).toThrow(WalletValueError);
  });
});

describe("credits: 1 credit is 1,000,000 micro credits", () => {
  it("converts whole credits to micro credits and back", () => {
    expect(MICRO_PER_CREDIT).toBe(1_000_000);
    expect(creditsToMicro(1)).toBe(1_000_000);
    expect(creditsToMicro(6000)).toBe(6_000_000_000);
    expect(microToCredits(10_000_000)).toBe("10");
    expect(microToCredits(500_000)).toBe("0.5");
    expect(microToCredits(0)).toBe("0");
  });

  it("refuses credits that are not whole, above zero and inside the limit", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 1_000_001, "5", null]) expect(() => creditsToMicro(bad as never), String(bad)).toThrow(WalletValueError);
    expect(() => microToCredits(-1)).toThrow(WalletValueError);
  });

  it("round trips every price", () => {
    for (const micro of Object.values(WALLET_PRICES_MICRO)) expect(creditsToMicro(Number(microToCredits(micro)))).toBe(micro);
  });
});

describe("the switch", () => {
  it("is on only when WALLET_ENABLED is exactly the word true", () => {
    expect(walletEnabled({ WALLET_ENABLED: "true" })).toBe(true);
    for (const v of [undefined, "", "TRUE", "True", "1", "yes", "true ", " true", "on"]) expect(walletEnabled({ WALLET_ENABLED: v }), String(v)).toBe(false);
    expect(walletEnabled({})).toBe(false);
  });
});
