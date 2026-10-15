import { describe, it, expect, afterEach, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { SpringPanel } from "./SpringPanel";

// Spring enter/exit for the mobile nav menu and the support widget panel (2026-10-14, Werner's Apple-design repairs).
// jsdom has no real compositor, so these cover mounting, origin, reduced-motion and exit-then-unmount behaviour; the
// feel of the spring itself is checked in a real browser (see the report).

function mockReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 80)); });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SpringPanel", () => {
  it("renders nothing while closed", () => {
    mockReducedMotion(false);
    render(<SpringPanel open={false} origin="top right">hello</SpringPanel>);
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
  });

  it("renders the requested element with its props and a transform-origin at the trigger", () => {
    mockReducedMotion(false);
    render(
      <SpringPanel open origin="bottom right" as="nav" id="x" className="menu" aria-label="Menu">
        hello
      </SpringPanel>,
    );
    const el = screen.getByLabelText("Menu");
    expect(el.tagName).toBe("NAV");
    expect(el).toHaveAttribute("id", "x");
    expect(el).toHaveClass("menu");
    expect(el.style.transformOrigin).toBe("bottom right");
  });

  it("keeps the panel mounted while the exit spring runs, then removes it", async () => {
    mockReducedMotion(false);
    const { rerender } = render(<SpringPanel open origin="top right">hello</SpringPanel>);
    await settle();
    rerender(<SpringPanel open={false} origin="top right">hello</SpringPanel>);
    expect(screen.getByText("hello")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("hello")).not.toBeInTheDocument(), { timeout: 3000 });
  });
});
