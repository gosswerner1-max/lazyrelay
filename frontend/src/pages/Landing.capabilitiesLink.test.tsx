import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("../lib/api", () => ({ api: {} }));

import { Landing } from "./Landing";

afterEach(cleanup);

const noop = () => {};
const renderLanding = () =>
  render(<Landing onSignIn={noop} onGetStarted={noop} onPrivacy={noop} onTerms={noop} onDpa={noop} onContact={noop} onPartners={noop} onDocs={noop} scrollToPricing={false} />);

describe("the Capabilities page is linked from the landing page", () => {
  it("in the main header navigation", () => {
    const { container } = renderLanding();
    const nav = container.querySelector("nav.landing-nav-links") as HTMLElement;
    const link = within(nav).getByRole("link", { name: "Capabilities" });
    expect(link).toHaveAttribute("href", "/capabilities/");
  });

  it("in the footer links", () => {
    const { container } = renderLanding();
    const footer = container.querySelector("p.landing-footer-links") as HTMLElement;
    expect(within(footer).getByRole("link", { name: "Capabilities" })).toHaveAttribute("href", "/capabilities/");
  });

  it("in the mobile menu, which closes when it is used", async () => {
    renderLanding();
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    await waitFor(() => expect(document.getElementById("mobile-nav-menu")).not.toBeNull(), { timeout: 8000 });
    const menu = document.getElementById("mobile-nav-menu") as HTMLElement;
    const link = within(menu).getByRole("link", { name: "Capabilities" });
    expect(link).toHaveAttribute("href", "/capabilities/");
    fireEvent.click(link);
    await waitFor(() => expect(document.getElementById("mobile-nav-menu")).toBeNull(), { timeout: 3000 });
  }, 20000);

  it("the link text has no dash and the page link is a plain relative path", () => {
    const { container } = renderLanding();
    const links = [...container.querySelectorAll('a[href="/capabilities/"]')];
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const l of links) expect(l.textContent).toBe("Capabilities");
  });
});
