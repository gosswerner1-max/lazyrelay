import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OLD_CHECKOUT_CLOSED_MESSAGE, oldTierCheckoutClosed } from "./closeOldCheckout.js";

const ACCOUNT = "6f1d0a52-3c1e-4e0a-9d6e-0b4b8d8f2a11";
const deps = (over: { mode?: "off" | "shadow" | "on"; legacy?: boolean } = {}) => ({
  mode: () => over.mode ?? "on",
  isLegacy: vi.fn().mockResolvedValue(over.legacy ?? false),
});

describe("the old six tier checkout when the wallet is on", () => {
  it("is closed to a buyer who is not a legacy account", async () => {
    expect(await oldTierCheckoutClosed(ACCOUNT, deps())).toBe(true);
  });

  it("stays open to a legacy account", async () => {
    expect(await oldTierCheckoutClosed(ACCOUNT, deps({ legacy: true }))).toBe(false);
  });

  it("stays open with the wallet off, without even asking who the account is (identical to today)", async () => {
    const d = deps({ mode: "off" });
    expect(await oldTierCheckoutClosed(ACCOUNT, d)).toBe(false);
    expect(d.isLegacy).not.toHaveBeenCalled();
  });

  it("stays open in shadow mode (nothing changes for customers until the wallet is on)", async () => {
    expect(await oldTierCheckoutClosed(ACCOUNT, deps({ mode: "shadow" }))).toBe(false);
  });

  it("the message has no dashes and points at the new plans", () => {
    expect(OLD_CHECKOUT_CLOSED_MESSAGE).not.toMatch(/[–—-]/);
    expect(OLD_CHECKOUT_CLOSED_MESSAGE).toMatch(/Growth/);
  });
});

describe("the route", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "http", "routes", "billing.routes.ts"), "utf8");
  const start = source.indexOf('router.post("/subscription/checkout"');
  const body = source.slice(start, source.indexOf('router.post("/subscription/change-tier"', start));

  it("POST /subscription/checkout asks the gate before it takes the billing lock or touches Paddle", () => {
    expect(start).toBeGreaterThan(0);
    const gate = body.indexOf("oldTierCheckoutClosed(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(body.indexOf("acquireBillingLock("));
    expect(gate).toBeLessThan(body.indexOf("buildCheckoutTransaction("));
  });

  it("answers 403 with the fixed message", () => {
    expect(body).toMatch(/status\(403\)\.json\(\{ error: OLD_CHECKOUT_CLOSED_MESSAGE/);
  });
});
