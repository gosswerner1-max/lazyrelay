import { afterEach, describe, it, expect } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

// Motion reads prefers-reduced-motion once per page load, so this lives in its own file (own module registry) with the
// media query mocked before anything imports it.
window.matchMedia = ((query: string) => ({
  matches: query.includes("prefers-reduced-motion"),
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const { SpringPanel } = await import("./SpringPanel");

afterEach(cleanup);

describe("SpringPanel under prefers-reduced-motion", () => {
  it("never applies a transform: opacity cross-fade only", async () => {
    render(<SpringPanel open origin="top right" aria-label="Menu">hello</SpringPanel>);
    const el = screen.getByLabelText("Menu");
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect(el.style.transform === "" || el.style.transform === "none").toBe(true);
    expect(el.style.scale === "" || el.style.scale === "none").toBe(true);
  });
});
