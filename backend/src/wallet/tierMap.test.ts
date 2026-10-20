import { describe, it, expect } from "vitest";
import { walletPlanForTier, tierForWalletPlan, WALLET_PLAN_TIERS } from "./tierMap.js";
import { PLAN_IDS } from "./plans.js";
import type { Tier } from "../tier.js";

describe("wallet plan to tier map", () => {
  it("maps each wallet plan to its tier", () => {
    expect(WALLET_PLAN_TIERS).toEqual({ free: "free", payg: "payg", growth: "growth", pro: "lazy_pro" });
  });

  it("covers exactly the plan ids in plans.ts", () => {
    expect(Object.keys(WALLET_PLAN_TIERS).sort()).toEqual([...PLAN_IDS].sort());
  });

  it("walletPlanForTier: the four wallet tiers map, the old paid tiers are null", () => {
    expect(walletPlanForTier("free")).toBe("free");
    expect(walletPlanForTier("payg")).toBe("payg");
    expect(walletPlanForTier("growth")).toBe("growth");
    expect(walletPlanForTier("lazy_pro")).toBe("pro");
    for (const t of ["starter", "pro", "business", "agency", "agency_plus"] as Tier[]) expect(walletPlanForTier(t), t).toBeNull();
  });

  it("the old pro tier is never the wallet pro plan", () => {
    expect(walletPlanForTier("pro")).toBeNull();
    expect(tierForWalletPlan("pro")).toBe("lazy_pro");
  });

  it("tierForWalletPlan is the reverse of walletPlanForTier", () => {
    for (const plan of PLAN_IDS) expect(walletPlanForTier(tierForWalletPlan(plan))).toBe(plan);
  });
});
