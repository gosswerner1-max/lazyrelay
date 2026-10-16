import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("../lib/api", () => ({ api: {} }));

import { Landing } from "./Landing";

// The home page "Works with" strip (2026-10-16): 18 distribution platforms (the original 17 plus X) and WhatsApp,
// which is client messaging. Each icon is drawn as an aria-hidden SVG, so each one gets a named wrapper.
afterEach(cleanup);

function renderLanding() {
  const noop = () => {};
  return render(
    <Landing onSignIn={noop} onGetStarted={noop} onPrivacy={noop} onTerms={noop} onDpa={noop}
      onContact={noop} onPartners={noop} onDocs={noop} scrollToPricing={false} />,
  );
}

describe("Landing 'Works with' strip", () => {
  it("shows 19 named icons: the 18 distribution platforms and WhatsApp, X after the social networks and WhatsApp last", () => {
    renderLanding();
    const row = document.querySelector(".landing-platforms .platform-row")!;
    const items = [...row.querySelectorAll('[role="img"]')];
    const names = items.map((el) => el.getAttribute("aria-label"));
    expect(names).toHaveLength(19);
    expect(new Set(names).size).toBe(19);
    expect(names).toContain("X");
    expect(names[names.length - 1]).toBe("WhatsApp");
    expect(names.indexOf("X")).toBeGreaterThan(names.indexOf("Tumblr"));
    for (const el of items) expect(el.querySelector("svg"), el.getAttribute("aria-label") ?? "").not.toBeNull();
  });

  it("states the standard count and what X and WhatsApp are, without dashes", () => {
    renderLanding();
    const section = document.querySelector(".landing-platforms")!;
    const text = section.textContent ?? "";
    expect(text).toContain("18 distribution platforms plus WhatsApp");
    expect(text).toMatch(/own X developer keys/);
    expect(text).toMatch(/WhatsApp is client messaging/);
    expect(text).not.toMatch(/[–—]/);
  });
});
