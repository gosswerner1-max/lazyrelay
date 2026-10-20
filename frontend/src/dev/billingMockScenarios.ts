// DEV ONLY mock wallets for the billing mockup page. Imported only by pages/dev/BillingMockupPage.tsx, which App.tsx loads
// only behind import.meta.env.DEV. Nothing here is real account data and nothing here reaches a server.

import type { CreditLot } from "../lib/billingSummary";

/** The fixed "now" every scenario is written against. */
export const MOCK_NOW = "2026-10-20T12:00:00Z";

export interface MockScenario {
  id: string;
  label: string;
  lots: CreditLot[];
}

const pro = (remaining: number, expiresAt: string | null, autoRenew = true): CreditLot => ({
  kind: "subscription",
  remaining,
  expiresAt,
  autoRenew,
  planName: "Pro",
});
const topup = (remaining: number, expiresAt: string): CreditLot => ({ kind: "topup", remaining, expiresAt, boundPlan: "pro" });
const pack = (remaining: number): CreditLot => ({ kind: "pack", remaining, expiresAt: null });
const signup = (remaining: number): CreditLot => ({ kind: "signup", remaining, expiresAt: null });

export const MOCK_SCENARIOS: MockScenario[] = [
  {
    id: "healthy",
    label: "Pro plan, top-up and pay-as-you-go (healthy)",
    lots: [pro(1200, "2026-11-10T12:00:00Z"), topup(500, "2026-11-10T12:00:00Z"), pack(300), signup(30)],
  },
  {
    id: "low",
    label: "Growth plan, low balance (orange)",
    lots: [{ kind: "subscription", remaining: 60, expiresAt: "2026-11-02T12:00:00Z", autoRenew: true, planName: "Growth" }, pack(15)],
  },
  {
    id: "critical",
    label: "Critical balance (red, flashing)",
    lots: [{ kind: "subscription", remaining: 6, expiresAt: "2026-11-03T12:00:00Z", autoRenew: true, planName: "Growth" }, signup(4)],
  },
  {
    id: "expiring",
    label: "Plan expires in 3 days (banner)",
    lots: [pro(800, "2026-10-23T12:00:00Z"), topup(200, "2026-10-23T12:00:00Z"), pack(50)],
  },
  {
    id: "cancelled",
    label: "Plan cancelled, ends in 12 days",
    lots: [pro(600, "2026-11-01T12:00:00Z", false), topup(100, "2026-11-01T12:00:00Z"), pack(40)],
  },
  { id: "free", label: "Free account (30 free credits)", lots: [signup(30)] },
  { id: "payg", label: "Pay-as-you-go only", lots: [pack(450)] },
  { id: "empty", label: "Empty wallet", lots: [] },
];
