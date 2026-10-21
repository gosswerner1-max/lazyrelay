// The Account workspace: a dark single-screen shell with a section list around the existing Settings sections, which are rendered unchanged.
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("./SettingsTab", () => ({
  SettingsTab: () => (
    <div>
      <section><h2>Account</h2><button>Change email</button></section>
      <section><h2>Two-factor authentication</h2></section>
      <section><h2>Billing</h2></section>
    </div>
  ),
}));
import { AccountWorkspaceTab } from "./AccountWorkspaceTab";

afterEach(cleanup);

describe("AccountWorkspaceTab", () => {
  it("renders the existing settings sections untouched inside the shell", () => {
    render(<AccountWorkspaceTab />);
    expect(screen.getByRole("button", { name: "Change email" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Billing" })).toBeInTheDocument();
  });
  it("lists every section in a jump list and scrolls to the one chosen, changing nothing", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<AccountWorkspaceTab />);
    const nav = screen.getByRole("navigation", { name: /account sections/i });
    const items = Array.from(nav.querySelectorAll("button")).map((b) => b.textContent);
    expect(items).toEqual(["Account", "Two-factor authentication", "Billing"]);
    await userEvent.click(nav.querySelectorAll("button")[2]);
    expect(scroll).toHaveBeenCalledTimes(1);
  });
});
