import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The "Remove App Secret" control on the WhatsApp card: a small button on a connection whose inbound is ready, an inline
// confirm (not a browser dialog), and what happens on success and on error. The API is a mock: nothing real is called.

const api = vi.hoisted(() => ({
  checkXKeys: vi.fn(),
  connectXKeys: vi.fn(),
  checkWhatsAppCredentials: vi.fn(),
  connectWhatsAppCredentials: vi.fn(),
  getWhatsAppWebhookInfo: vi.fn(),
  getWhatsAppMessages: vi.fn(),
  removeWhatsAppAppSecret: vi.fn(),
}));
vi.mock("../../lib/api", () => ({ api }));

import { CustomPlatformSettings } from "./CustomPlatformSettings";
import type { PlatformInfo, WhatsAppWebhookInfo } from "../../lib/api";

const WA_OK: PlatformInfo = { platform: "whatsapp", configured: true, comingSoon: false, requiresPlan: "Business", allowed: true };
const SA1 = "11111111-1111-4111-8111-111111111111";
const SA2 = "22222222-2222-4222-8222-222222222222";
// Fake values that merely look the right shape. Not real credentials.
const FAKE_SECRET = "AppSecretNotReal0123456789abcdefAB";
const FAKE_TOKEN = "test_whatsapp_system_user_token_not_real_0123456789";
const WARNING = "Inbound messages will stop for this number until you save an App Secret again. Your token and IDs are not changed.";

const INFO: WhatsAppWebhookInfo = {
  webhookUrl: "https://api.example.test/api/webhooks/whatsapp",
  verifyToken: "handshake-token-not-real",
  verifyTokenConfigured: true,
  connections: [
    { socialAccountId: SA1, displayName: "Acme Cafe", inboundReady: true },
    { socialAccountId: SA2, displayName: "Acme Bakery", inboundReady: false },
  ],
  triageEnabled: false,
};
const INFO_AFTER: WhatsAppWebhookInfo = { ...INFO, connections: [{ ...INFO.connections[0], inboundReady: false }, INFO.connections[1]] };

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getWhatsAppWebhookInfo.mockResolvedValue(INFO);
  api.removeWhatsAppAppSecret.mockResolvedValue({ ok: true, inboundReady: false });
});

const trigger = () => screen.getByRole("button", { name: "Remove App Secret for Acme Cafe" });
async function openConfirm(user: ReturnType<typeof userEvent.setup>) {
  render(<CustomPlatformSettings platforms={[WA_OK]} />);
  await screen.findByText("Acme Cafe");
  await user.click(trigger());
  return screen.getByRole("alertdialog");
}

describe("Remove App Secret button", () => {
  it("shows only on a connection whose inbound is ready", async () => {
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    const list = await screen.findByRole("list", { name: "Inbound status for each connected WhatsApp number" });
    const [ready, off] = within(list).getAllByRole("listitem");
    expect(within(ready).getByRole("button", { name: "Remove App Secret for Acme Cafe" })).toHaveTextContent("Remove App Secret");
    expect(within(off).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Remove App Secret/ })).toHaveLength(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("is not there at all while loading, on a load error, with no connections, or on a locked plan", async () => {
    api.getWhatsAppWebhookInfo.mockReturnValueOnce(new Promise(() => {}));
    const first = render(<CustomPlatformSettings platforms={[WA_OK]} />);
    expect(screen.queryByRole("button", { name: /Remove App Secret/ })).not.toBeInTheDocument();
    first.unmount();
    api.getWhatsAppWebhookInfo.mockRejectedValueOnce(new Error("Request failed: 500"));
    const second = render(<CustomPlatformSettings platforms={[WA_OK]} />);
    await screen.findByText(/Could not check the inbound status right now/);
    expect(screen.queryByRole("button", { name: /Remove App Secret/ })).not.toBeInTheDocument();
    second.unmount();
    api.getWhatsAppWebhookInfo.mockResolvedValueOnce({ ...INFO, connections: [] });
    const third = render(<CustomPlatformSettings platforms={[WA_OK]} />);
    await screen.findByText(/No WhatsApp number is connected yet/);
    expect(screen.queryByRole("button", { name: /Remove App Secret/ })).not.toBeInTheDocument();
    third.unmount();
    render(<CustomPlatformSettings platforms={[{ ...WA_OK, allowed: false }]} onSeePlans={vi.fn()} />);
    expect(screen.getByText("Available on the Business plan and above.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove App Secret/ })).not.toBeInTheDocument();
    expect(api.getWhatsAppWebhookInfo).toHaveBeenCalledTimes(3); // the three renders above, none for the locked card
    expect(api.removeWhatsAppAppSecret).not.toHaveBeenCalled();
  });
});

describe("the inline confirm", () => {
  it("opens inside the card as a labelled alertdialog with the plain warning, and moves the focus to Remove secret", async () => {
    const user = userEvent.setup();
    const confirm = await openConfirm(user);
    expect(confirm).toHaveAccessibleName("Remove the App Secret for Acme Cafe?");
    expect(confirm).toHaveAccessibleDescription(WARNING);
    expect(within(confirm).getByText(WARNING)).toBeInTheDocument();
    expect(within(confirm).getByRole("button", { name: "Remove secret" })).toHaveFocus();
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(confirm.closest(".byok-panels")).not.toBeNull(); // inside the card, not a portal
    expect(api.removeWhatsAppAppSecret).not.toHaveBeenCalled();
  });

  it("Cancel does nothing and puts the focus back on the button that opened it", async () => {
    const user = userEvent.setup();
    const confirm = await openConfirm(user);
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.removeWhatsAppAppSecret).not.toHaveBeenCalled();
    expect(api.getWhatsAppWebhookInfo).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it("Escape cancels the same way", async () => {
    const user = userEvent.setup();
    await openConfirm(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.removeWhatsAppAppSecret).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it("Remove secret calls the function once with this connection's id, and is disabled while it runs", async () => {
    let finish!: (v: { ok: true; inboundReady: false }) => void;
    api.removeWhatsAppAppSecret.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const user = userEvent.setup();
    const confirm = await openConfirm(user);
    await user.click(within(confirm).getByRole("button", { name: "Remove secret" }));
    expect(api.removeWhatsAppAppSecret).toHaveBeenCalledTimes(1);
    expect(api.removeWhatsAppAppSecret).toHaveBeenCalledWith(SA1);
    const busy = within(screen.getByRole("alertdialog")).getByRole("button", { name: "Removing..." });
    expect(busy).toBeDisabled();
    expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}"); // cannot be cancelled while the request runs
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    finish({ ok: true, inboundReady: false });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(api.removeWhatsAppAppSecret).toHaveBeenCalledTimes(1);
  });

  it("on success: the chips are fetched again, a polite live region announces it, and the focus stays on the row", async () => {
    api.getWhatsAppWebhookInfo.mockResolvedValueOnce(INFO).mockResolvedValueOnce(INFO_AFTER);
    const user = userEvent.setup();
    const confirm = await openConfirm(user);
    await user.click(within(confirm).getByRole("button", { name: "Remove secret" }));
    await waitFor(() => expect(api.getWhatsAppWebhookInfo).toHaveBeenCalledTimes(2));
    const live = screen.getByText("App Secret removed. Inbound is off for this number.");
    expect(live).toHaveAttribute("role", "status");
    expect(live).toHaveAttribute("aria-live", "polite");
    const list = screen.getByRole("list", { name: "Inbound status for each connected WhatsApp number" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("Inbound off: App Secret not saved"));
    expect(screen.queryByRole("button", { name: /Remove App Secret/ })).not.toBeInTheDocument(); // nothing left to remove
    await waitFor(() => expect(within(list).getByText("Acme Cafe")).toHaveFocus());
  });

  it("on error: a calm fixed message, the confirm stays open with the focus on Remove secret, and nothing was refreshed", async () => {
    api.removeWhatsAppAppSecret.mockRejectedValueOnce(new Error(`boom ${FAKE_SECRET} Request failed: 500`));
    const user = userEvent.setup();
    const confirm = await openConfirm(user);
    await user.click(within(confirm).getByRole("button", { name: "Remove secret" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The App Secret could not be removed right now. It is still saved. Please try again.");
    expect(document.body.textContent).not.toContain(FAKE_SECRET); // the server's own words are never shown
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove secret" })).toHaveFocus());
    expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove secret" })).toBeEnabled();
    expect(api.getWhatsAppWebhookInfo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/App Secret removed/)).not.toBeInTheDocument();
    // and a second try can succeed
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove secret" }));
    await waitFor(() => expect(api.removeWhatsAppAppSecret).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("never puts an App Secret or token in the page, and a new request clears the old announcement", async () => {
    api.getWhatsAppWebhookInfo.mockResolvedValueOnce(INFO).mockResolvedValue(INFO);
    const user = userEvent.setup();
    const confirm = await openConfirm(user);
    expect(document.body.innerHTML).not.toContain(FAKE_SECRET);
    expect(document.body.innerHTML).not.toContain(FAKE_TOKEN);
    await user.click(within(confirm).getByRole("button", { name: "Remove secret" }));
    await screen.findByText("App Secret removed. Inbound is off for this number.");
    await user.click(trigger());
    expect(screen.queryByText("App Secret removed. Inbound is off for this number.")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(FAKE_SECRET);
    expect(document.body.innerHTML).not.toContain(FAKE_TOKEN);
  });
});
