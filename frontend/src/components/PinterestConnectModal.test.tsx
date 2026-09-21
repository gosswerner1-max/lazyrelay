import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PinterestConnectModal } from "./PinterestConnectModal";

// En-dash and em-dash, built from code points so no literal dash sits in this file.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

// Vitest globals are off here, so testing-library does not auto-clean between tests.
afterEach(cleanup);

describe("PinterestConnectModal", () => {
  it("is a labelled, modal dialog with the required title and the four points in order", () => {
    render(<PinterestConnectModal onConnect={() => {}} onCancel={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Before you connect Pinterest" });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      "New Pinterest account? Warm it up by hand first. Post 1 pin a day for the first week, then 2, then 3, until it reaches 100+ monthly views (about 2 weeks). Then connect it.",
      "Promoting a brand-new website? Pinterest checks new websites closely. Start slowly and vary your captions.",
      "LazyRelay allows up to 10 pins a day per Pinterest account.",
      "If Pinterest blocks a link, that decision is Pinterest's. You can ask Pinterest to review it in its Help Center.",
    ]);
    // Plain-language copy rule: no em-dash or en-dash anywhere in the dialog.
    expect(dialog.textContent).not.toMatch(DASHES);
  });

  it("moves focus into the dialog when it opens", () => {
    render(<PinterestConnectModal onConnect={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  it("continues the connect only when 'Connect Pinterest' is pressed", async () => {
    const onConnect = vi.fn();
    const onCancel = vi.fn();
    render(<PinterestConnectModal onConnect={onConnect} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect Pinterest" }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels from the Cancel button, from Escape, and from a click on the backdrop", async () => {
    const onConnect = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(<PinterestConnectModal onConnect={onConnect} onCancel={onCancel} />);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);

    await userEvent.click(container.querySelector(".modal-overlay") as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(3);

    // A click inside the card must not count as a backdrop click.
    await userEvent.click(screen.getByRole("dialog"));
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the dialog, both directions", async () => {
    render(<PinterestConnectModal onConnect={() => {}} onCancel={() => {}} />);
    const connect = screen.getByRole("button", { name: "Connect Pinterest" });
    const cancel = screen.getByRole("button", { name: "Cancel" });

    await userEvent.tab(); // dialog -> Connect
    expect(connect).toHaveFocus();
    await userEvent.tab();
    expect(cancel).toHaveFocus();
    await userEvent.tab(); // wraps forward
    expect(connect).toHaveFocus();
    await userEvent.tab({ shift: true }); // wraps backward
    expect(cancel).toHaveFocus();
  });

  it("hands focus back to whatever opened it once it closes", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<PinterestConnectModal onConnect={() => {}} onCancel={() => {}} />);
    expect(opener).not.toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
