import { describe, expect, it } from "vitest";
import { MICRO_PER_CREDIT, WalletValueError, creditsToMicro, microToCredits } from "./money.js";
import { WALLET_PRICES_MICRO } from "./prices.js";
import { walletEnabled } from "./flags.js";

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
