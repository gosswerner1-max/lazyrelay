import { afterEach, describe, expect, it, vi } from "vitest";

// The flag is read once when the module loads, so each test sets it first and imports a fresh copy.
async function load(value?: string) {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (value !== undefined) vi.stubEnv("VITE_BILLING_ENABLED", value);
  return (await import("./billingFlag")).BILLING_ENABLED;
}

afterEach(() => vi.unstubAllEnvs());

describe("BILLING_ENABLED", () => {
  it("is off when the variable is not set", async () => {
    expect(await load()).toBe(false);
  });
  it("is off for anything except the exact word true", async () => {
    for (const v of ["false", "1", "TRUE", "yes", ""]) expect(await load(v), JSON.stringify(v)).toBe(false);
  });
  it("is on for the exact word true", async () => {
    expect(await load("true")).toBe(true);
  });
});
