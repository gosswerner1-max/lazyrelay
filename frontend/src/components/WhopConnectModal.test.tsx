import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({
  whopConfig: vi.fn(),
  whopStartChallenge: vi.fn(),
  whopVerify: vi.fn(),
}));
vi.mock("../lib/api", () => ({ api }));

import { WhopConnectModal } from "./WhopConnectModal";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const INSTALL = "https://whop.com/apps/app_Example1234/install";
const CHALLENGE = {
  challengeId: "ch1",
  code: "lazyrelay-abcdefghjkmn",
  companyId: "biz_Example1234",
  companyTitle: "Example Community",
  forums: [{ id: "exp_Forum1", name: "Forums (Example Community)" }],
  expiresAt: "2026-10-01T12:00:00Z",
};

function setup() {
  api.whopConfig.mockResolvedValue({ installUrl: INSTALL });
  const onCancel = vi.fn();
  const onSelection = vi.fn();
  const view = render(<WhopConnectModal onCancel={onCancel} onSelection={onSelection} />);
  return { onCancel, onSelection, view };
}

describe("Whop connect dialog", () => {
  it("step 1 opens the install link served by the backend (not hardcoded) in a new tab, in plain words", async () => {
    const { view } = setup();
    const link = await screen.findByRole("link", { name: "Open the Whop install page" });
    expect(link).toHaveAttribute("href", INSTALL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(view.container.textContent).toMatch(/approve the three permissions/);
    expect(view.container.textContent).not.toMatch(DASHES);
  });

  it("walks install, community, code, and hands the selection token over when the check passes", async () => {
    api.whopStartChallenge.mockResolvedValue(CHALLENGE);
    api.whopVerify.mockResolvedValue({ selectionToken: "sel1" });
    const { onSelection, view } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "I have installed it" }));
    await userEvent.type(screen.getByLabelText("Community id"), "  biz_Example1234 ");
    await userEvent.click(screen.getByRole("button", { name: "Get my code" }));
    expect(api.whopStartChallenge).toHaveBeenCalledWith("biz_Example1234");
    expect(await screen.findByTestId("whop-code")).toHaveTextContent(CHALLENGE.code);
    expect(screen.getByText("Forums (Example Community)")).toBeInTheDocument();
    expect(view.container.textContent).toMatch(/owner or an admin/);
    expect(view.container.textContent).toMatch(/new post, not a comment/);
    expect(view.container.textContent).not.toMatch(DASHES);
    await userEvent.click(screen.getByRole("button", { name: "I posted it, check now" }));
    await waitFor(() => expect(onSelection).toHaveBeenCalledWith("sel1"));
    expect(api.whopVerify).toHaveBeenCalledWith("ch1");
  });

  it("shows the backend's plain-language refusal and stays on the step when the check fails", async () => {
    api.whopStartChallenge.mockResolvedValue(CHALLENGE);
    api.whopVerify.mockRejectedValue(new Error("LazyRelay could not find your code yet."));
    const { onSelection } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "I have installed it" }));
    await userEvent.type(screen.getByLabelText("Community id"), "biz_Example1234");
    await userEvent.click(screen.getByRole("button", { name: "Get my code" }));
    await userEvent.click(await screen.findByRole("button", { name: "I posted it, check now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not find your code yet");
    expect(onSelection).not.toHaveBeenCalled();
    expect(screen.getByTestId("whop-code")).toBeInTheDocument();
  });

  it("a community that has not installed the app shows the backend's message on the community step", async () => {
    api.whopStartChallenge.mockRejectedValue(new Error("LazyRelay is not installed in that community yet."));
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "I have installed it" }));
    await userEvent.type(screen.getByLabelText("Community id"), "biz_Example1234");
    await userEvent.click(screen.getByRole("button", { name: "Get my code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not installed in that community yet");
    expect(screen.queryByTestId("whop-code")).toBeNull();
  });

  it("Cancel closes it", async () => {
    const { onCancel } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
