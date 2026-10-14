import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../lib/api", () => ({ api: {} }));

import { Landing } from "./Landing";

// The mobile nav menu used to appear/disappear instantly (2026-10-14 Apple-design repair): it now springs out of the
// hamburger corner and stays mounted until the exit finishes.
afterEach(cleanup);

describe("Landing mobile nav menu motion", () => {
  it("springs in from the toggle corner and unmounts after the exit", async () => {
    const noop = () => {};
    render(
      <Landing onSignIn={noop} onGetStarted={noop} onPrivacy={noop} onTerms={noop} onDpa={noop}
        onContact={noop} onPartners={noop} onDocs={noop} scrollToPricing={false} />,
    );
    expect(document.getElementById("mobile-nav-menu")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    await waitFor(() => expect(document.getElementById("mobile-nav-menu")).not.toBeNull(), { timeout: 8000 }); // code-split panel: first load compiles the chunk, slow under a full run
    const menu = document.getElementById("mobile-nav-menu")!;
    expect(menu).not.toBeNull();
    expect(menu.style.transformOrigin).toBe("top right");
    await waitFor(() => expect(menu.style.opacity).toBe("1"), { timeout: 5000 }); // enter finished, so the animation engine has loaded

    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(document.getElementById("mobile-nav-menu")).not.toBeNull(); // exit still running
    await waitFor(() => expect(document.getElementById("mobile-nav-menu")).toBeNull(), { timeout: 3000 });
  }, 20000);
});
