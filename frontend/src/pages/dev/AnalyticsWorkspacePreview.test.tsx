import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("../../lib/api", () => ({}));
import { AnalyticsWorkspacePreview } from "./AnalyticsWorkspacePreview";

beforeEach(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(cleanup);

describe("AnalyticsWorkspacePreview (dev only)", () => {
  it("shows the Insights workspace on made-up brands and example.com links only", () => {
    render(<AnalyticsWorkspacePreview />);
    expect(screen.getByRole("heading", { name: /insights/i })).toBeInTheDocument();
    expect(within(screen.getByLabelText("Brand")).getByRole("option", { name: "Alpha Brand" })).toBeInTheDocument();
    const links = within(screen.getByRole("list", { name: /proof-of-publish/i })).getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l.getAttribute("href")).toMatch(/^https:\/\/example\.com\//);
  });
  it("lets the range buttons and the brand dropdown change what is shown", () => {
    render(<AnalyticsWorkspacePreview />);
    const before = screen.getByRole("group", { name: "Published" }).textContent;
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText("Brand"), { target: { value: "Beta Brand" } });
    expect((screen.getByLabelText("Brand") as HTMLSelectElement).value).toBe("Beta Brand");
    expect(screen.getByRole("group", { name: "Published" }).textContent).not.toBe(before);
  });
});
