import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bannerPlanName, splitDashboardTabs, type Tab } from "./dashboardHelpers";

vi.mock("../../lib/supabase", () => ({ supabase: {} })); // the real client refuses to start without its address

const src = (rel: string) => readFileSync(resolve(__dirname, "../../..", rel), "utf8");

describe("bannerPlanName", () => {
  it("names the active wallet plan", () => {
    expect(bannerPlanName("business", "payg")).toBe("Pay as you go");
    expect(bannerPlanName("starter", "growth")).toBe("Growth");
    expect(bannerPlanName("agency", "pro")).toBe("Pro");
  });

  it("names Free, Growth and Pro from the tier when no wallet plan is active", () => {
    expect(bannerPlanName("free", null)).toBe("Free");
    expect(bannerPlanName("growth", null)).toBe("Growth");
    expect(bannerPlanName("lazy_pro", undefined)).toBe("Pro");
  });

  it("returns null for legacy tiers so the banner wording is dropped", () => {
    for (const tier of ["starter", "business", "agency", "agency_plus"]) {
      expect(bannerPlanName(tier, null)).toBeNull();
    }
    expect(bannerPlanName(undefined, null)).toBeNull();
  });
});

describe("splitDashboardTabs", () => {
  const main: Tab[] = ["Compose", "Planner", "Overview", "Posts", "Failed", "Calendar", "Settings"];
  const more: Tab[] = ["Analytics", "Mentions"];

  it("moves the four original views behind More when the new views are on", () => {
    const out = splitDashboardTabs(main, more, true);
    expect(out.bar).toEqual(["Compose", "Planner", "Settings"]);
    expect(out.more).toEqual(["Overview", "Posts", "Failed", "Calendar", "Analytics", "Mentions"]);
  });

  it("leaves the bar unchanged when no new view is on", () => {
    const out = splitDashboardTabs(main, more, false);
    expect(out.bar).toEqual(main);
    expect(out.more).toEqual(more);
  });
});

describe("palette lock: no purple or violet in the shared styling", () => {
  const banned = /violet|purple|#7c3aed|#a78bfa|#8b5cf6/i;
  it.each([
    "src/index.css",
    "src/components/CircuitBackground.tsx",
    "public/circuit-bg.css",
    "public/circuit-bg.js",
  ])("%s has no violet variable or colour", (file) => {
    const stripped = src(file).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
    expect(stripped).not.toMatch(banned);
  });

  it("Charts.tsx has no #8b5cf6", () => {
    expect(src("src/components/Charts.tsx")).not.toMatch(/#8b5cf6/i);
  });
});
