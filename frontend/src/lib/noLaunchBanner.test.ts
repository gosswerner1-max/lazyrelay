import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import landingSource from "../pages/Landing.tsx?raw";

// The top-of-page "Launch discount: 20% off your first 3 months" banner is removed (Werner, 2026-10-15): a public
// discount code would clash with the partner program's own codes. The banner must not come back by accident, and its
// now-unused styles must not linger. (The newsletter section further down is a separate decision.)
// The stylesheet is read from disk: importing a .css file with ?raw can come back empty under the test setup.
const appCss = readFileSync("src/App.css", "utf8"); // vitest runs from the frontend folder

describe("home page launch banner", () => {
  it("has no top banner advertising a launch discount", () => {
    expect(landingSource).not.toContain('className="promo-banner"');
    expect(landingSource).not.toMatch(/Launch discount: 20% off/);
  });

  it("reads a real stylesheet (guards against a vacuous check)", () => {
    expect(appCss).toContain(".landing-newsletter");
  });

  it("has no leftover banner styles", () => {
    expect(appCss).not.toMatch(/\.promo-banner/);
  });
});
