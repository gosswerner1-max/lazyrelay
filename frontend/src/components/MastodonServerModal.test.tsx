import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MastodonServerModal } from "./MastodonServerModal";

// En-dash and em-dash, built from code points so no literal dash sits in this file.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

afterEach(cleanup);

describe("MastodonServerModal", () => {
  it("is a labelled modal dialog asking for the server, with the agreed placeholder and hint", () => {
    render(<MastodonServerModal onConnect={() => {}} onCancel={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Connect Mastodon" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const input = screen.getByLabelText("Mastodon server");
    expect(input).toHaveAttribute("placeholder", "mastodon.social");
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(dialog.textContent).toContain("The address of the server your account is on, for example hachyderm.io");
    expect(dialog.textContent).not.toMatch(DASHES);
  });

  it("connects with the typed server, trimmed", async () => {
    const onConnect = vi.fn();
    render(<MastodonServerModal onConnect={onConnect} onCancel={() => {}} />);
    await userEvent.type(screen.getByLabelText("Mastodon server"), "  hachyderm.io ");
    await userEvent.click(screen.getByRole("button", { name: "Connect Mastodon" }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect).toHaveBeenCalledWith("hachyderm.io");
  });

  it("stays open and shows the problem inside the dialog when the connect cannot start", async () => {
    const onConnect = vi.fn(async () => "That server address is not allowed. It must be a public https address.");
    render(<MastodonServerModal onConnect={onConnect} onCancel={() => {}} />);
    await userEvent.type(screen.getByLabelText("Mastodon server"), "internal.example");
    await userEvent.click(screen.getByRole("button", { name: "Connect Mastodon" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That server address is not allowed. It must be a public https address.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Mastodon server")).toHaveValue("internal.example");
    // Fixing the address and trying again clears the old message.
    onConnect.mockResolvedValueOnce(null as never);
    await userEvent.click(screen.getByRole("button", { name: "Connect Mastodon" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Enter submits, and an empty box connects with an empty server (the mastodon.social default)", async () => {
    const onConnect = vi.fn();
    render(<MastodonServerModal onConnect={onConnect} onCancel={() => {}} />);
    await userEvent.keyboard("{Enter}");
    expect(onConnect).toHaveBeenCalledWith("");
  });

  it("remembers nothing between openings and stores nothing", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const first = render(<MastodonServerModal onConnect={() => {}} onCancel={() => {}} />);
    await userEvent.type(screen.getByLabelText("Mastodon server"), "hachyderm.io");
    first.unmount();
    render(<MastodonServerModal onConnect={() => {}} onCancel={() => {}} />);
    expect(screen.getByLabelText("Mastodon server")).toHaveValue("");
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it("cancels from the Cancel button, Escape and the backdrop, not from a click inside", async () => {
    const onConnect = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(<MastodonServerModal onConnect={onConnect} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
    await userEvent.click(container.querySelector(".modal-overlay") as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(3);
    await userEvent.click(screen.getByRole("dialog"));
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the dialog, both directions", async () => {
    render(<MastodonServerModal onConnect={() => {}} onCancel={() => {}} />);
    const input = screen.getByLabelText("Mastodon server");
    const connect = screen.getByRole("button", { name: "Connect Mastodon" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(input).toHaveFocus();
    await userEvent.tab();
    expect(connect).toHaveFocus();
    await userEvent.tab();
    expect(cancel).toHaveFocus();
    await userEvent.tab(); // wraps forward
    expect(input).toHaveFocus();
    await userEvent.tab({ shift: true }); // wraps backward
    expect(cancel).toHaveFocus();
  });
});
