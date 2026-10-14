import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../lib/api", () => ({ api: {} }));

import { SupportWidget } from "./SupportWidget";

// The support panel used to appear/disappear instantly (2026-10-14 Apple-design repair): it now springs in and out from
// the chat bubble, so closing keeps it mounted until the exit finishes.
afterEach(cleanup);

describe("SupportWidget panel motion", () => {
  it("springs out of the bubble corner and unmounts after the exit", async () => {
    render(<SupportWidget context="public" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open support chat" }));
    const panel = await screen.findByRole("dialog", {}, { timeout: 8000 }); // code-split panel: first load compiles the chunk, slow under a full run
    expect(panel.style.transformOrigin).toBe("bottom right");
    await waitFor(() => expect(panel.style.opacity).toBe("1"), { timeout: 5000 }); // enter finished, so the animation engine has loaded

    fireEvent.click(screen.getAllByRole("button", { name: "Close support chat" })[0]);
    expect(screen.getByRole("dialog")).toBeInTheDocument(); // exit still running
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 3000 });
  }, 20000);
});
