import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The WhatsApp card's follow-ups: the optional App Secret field and the per-connection inbound status chips, the webhook
// details with copy buttons, and the message history viewer. The API is a mock: nothing real is called.

const api = vi.hoisted(() => ({
  checkXKeys: vi.fn(),
  connectXKeys: vi.fn(),
  checkWhatsAppCredentials: vi.fn(),
  connectWhatsAppCredentials: vi.fn(),
  getWhatsAppWebhookInfo: vi.fn(),
  getWhatsAppMessages: vi.fn(),
}));
vi.mock("../../lib/api", () => ({ api }));

import { CustomPlatformSettings } from "./CustomPlatformSettings";
import { whatsAppFieldErrors, whatsAppFieldsComplete } from "../../lib/whatsappByok";
import type { PlatformInfo, WhatsAppWebhookInfo } from "../../lib/api";

const WA_OK: PlatformInfo = { platform: "whatsapp", configured: true, comingSoon: false, requiresPlan: "Business", allowed: true };
const FAKE_WA = { wabaId: "123456789012345", phoneNumberId: "109876543210987", systemUserToken: "test_whatsapp_system_user_token_not_real_0123456789" };
// Fake value that merely looks the right shape. Not a real Meta App Secret.
const FAKE_SECRET = "AppSecretNotReal0123456789abcdefAB";
const SA1 = "11111111-1111-4111-8111-111111111111";
const SA2 = "22222222-2222-4222-8222-222222222222";

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

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getWhatsAppWebhookInfo.mockResolvedValue(INFO);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

async function fillWa(user: ReturnType<typeof userEvent.setup>, withSecret = true) {
  await user.type(screen.getByLabelText("WABA ID"), FAKE_WA.wabaId);
  await user.type(screen.getByLabelText("Phone number ID"), FAKE_WA.phoneNumberId);
  await user.type(screen.getByLabelText("System user token"), FAKE_WA.systemUserToken);
  if (withSecret) await user.type(screen.getByLabelText("App Secret (optional)"), FAKE_SECRET);
}
const secretInput = () => screen.getByLabelText("App Secret (optional)") as HTMLInputElement;

describe("App Secret field", () => {
  it("is a hidden, non-autofilled input with a show/hide button, and is optional", async () => {
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    expect(secretInput().type).toBe("password");
    expect(secretInput().autocomplete).toBe("off");
    await user.click(screen.getByRole("button", { name: "Show App Secret (optional)" }));
    expect(secretInput().type).toBe("text");
    await user.click(screen.getByRole("button", { name: "Hide App Secret (optional)" }));
    expect(secretInput().type).toBe("password");
    // optional: the other three alone make the form complete
    await user.type(screen.getByLabelText("WABA ID"), FAKE_WA.wabaId);
    await user.type(screen.getByLabelText("Phone number ID"), FAKE_WA.phoneNumberId);
    await user.type(screen.getByLabelText("System user token"), FAKE_WA.systemUserToken);
    expect(screen.getByRole("button", { name: "Check my credentials" })).toBeEnabled();
  });

  it("uses the backend rule: 16 to 64 letters and digits; a wrong one is explained and blocks Check and Save", async () => {
    expect(whatsAppFieldsComplete({ ...FAKE_WA, appSecret: FAKE_SECRET })).toBe(true);
    for (const bad of ["short", "has spaces in it 0123456789", "a".repeat(65), 'quote"0123456789abcdef', "<script>0123456789ab"]) {
      expect(whatsAppFieldsComplete({ ...FAKE_WA, appSecret: bad }), bad).toBe(false);
      expect(whatsAppFieldErrors({ ...FAKE_WA, appSecret: bad }).appSecret, bad).toBeTruthy();
    }
    expect(whatsAppFieldErrors({ ...FAKE_WA, appSecret: "   " })).toEqual({}); // blank counts as not given
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    await fillWa(user, false);
    await user.type(secretInput(), "too short");
    expect(screen.getByText(/letters and numbers only, 16 to 64 characters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check my credentials" })).toBeDisabled();
  });

  it("Check sends it, and does not save", async () => {
    api.checkWhatsAppCredentials.mockResolvedValue({ ok: true, displayName: "Acme Cafe", keyHint: "****0987" });
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    await fillWa(user);
    await user.click(screen.getByRole("button", { name: "Check my credentials" }));
    await screen.findByText("Credentials accepted for Acme Cafe.");
    expect(api.checkWhatsAppCredentials).toHaveBeenCalledWith({ ...FAKE_WA, appSecret: FAKE_SECRET });
    expect(api.connectWhatsAppCredentials).not.toHaveBeenCalled();
  });

  it("Save sends it, clears it from the form at once, reloads the status, and never shows it anywhere", async () => {
    api.connectWhatsAppCredentials.mockResolvedValue({ ok: true, displayName: "Acme Cafe", keyHint: "****0987" });
    const user = userEvent.setup();
    const { container } = render(<CustomPlatformSettings platforms={[WA_OK]} />);
    await screen.findByText("Acme Cafe");
    await fillWa(user);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await waitFor(() => expect(api.connectWhatsAppCredentials).toHaveBeenCalledTimes(1));
    expect(api.connectWhatsAppCredentials).toHaveBeenCalledWith({ ...FAKE_WA, appSecret: FAKE_SECRET });
    await screen.findByText("Connected as Acme Cafe.");
    expect(secretInput().value).toBe("");
    expect(container.innerHTML).not.toContain(FAKE_SECRET);
    expect(JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }])).not.toContain(FAKE_SECRET);
    await waitFor(() => expect(api.getWhatsAppWebhookInfo).toHaveBeenCalledTimes(2)); // status reloaded after the save
  });

  it("is cleared (and hidden again) on every error, for both Check and Save", async () => {
    api.checkWhatsAppCredentials.mockRejectedValue(new Error("Meta did not accept this token."));
    api.connectWhatsAppCredentials.mockRejectedValue(new Error("Could not save your WhatsApp credentials. Please try again."));
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    await fillWa(user);
    await user.click(screen.getByRole("button", { name: "Show App Secret (optional)" }));
    await user.click(screen.getByRole("button", { name: "Check my credentials" }));
    await screen.findByRole("alert");
    expect(secretInput().value).toBe("");
    expect(secretInput().type).toBe("password");
    // the ids stay; only the two secrets were cleared
    await user.type(screen.getByLabelText("System user token"), FAKE_WA.systemUserToken);
    await user.type(secretInput(), FAKE_SECRET);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Could not save/));
    expect(secretInput().value).toBe("");
  });

  it("when none is typed, no appSecret key is sent at all", async () => {
    api.checkWhatsAppCredentials.mockResolvedValue({ ok: true, displayName: null, keyHint: "****0987" });
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    await fillWa(user, false);
    await user.click(screen.getByRole("button", { name: "Check my credentials" }));
    await waitFor(() => expect(api.checkWhatsAppCredentials).toHaveBeenCalledTimes(1));
    expect(Object.keys(api.checkWhatsAppCredentials.mock.calls[0][0]).sort()).toEqual(["phoneNumberId", "systemUserToken", "wabaId"]);
  });
});

describe("inbound status chips", () => {
  it("says in plain words that inbound stays off until an App Secret is saved", async () => {
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    expect(screen.getByText(/Inbound messages stay off for a connection until an App Secret is saved for it/)).toBeInTheDocument();
    await screen.findByText("Acme Cafe");
  });

  it("shows one chip per connection from the server's boolean: ready or off", async () => {
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    const list = await screen.findByRole("list", { name: "Inbound status for each connected WhatsApp number" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Acme Cafe");
    expect(rows[0]).toHaveTextContent("Inbound ready");
    expect(rows[1]).toHaveTextContent("Acme Bakery");
    expect(rows[1]).toHaveTextContent("Inbound off: App Secret not saved");
  });

  it("has a loading state, an empty state and an error state that does not break the form", async () => {
    let resolve!: (v: WhatsAppWebhookInfo) => void;
    api.getWhatsAppWebhookInfo.mockReturnValueOnce(new Promise<WhatsAppWebhookInfo>((r) => (resolve = r)));
    const { unmount } = render(<CustomPlatformSettings platforms={[WA_OK]} />);
    expect(screen.getByText("Checking your connections...")).toBeInTheDocument();
    resolve({ ...INFO, connections: [] });
    expect(await screen.findByText(/No WhatsApp number is connected yet/)).toBeInTheDocument();
    unmount();
    api.getWhatsAppWebhookInfo.mockRejectedValueOnce(new Error("Request failed: 500"));
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    expect(await screen.findByText(/Could not check the inbound status right now/)).toBeInTheDocument();
    expect(screen.getByLabelText("System user token")).toBeInTheDocument();
  });

  it("a locked plan shows the same locked card as before and never asks the server for webhook details", () => {
    render(<CustomPlatformSettings platforms={[{ ...WA_OK, allowed: false }]} onSeePlans={vi.fn()} />);
    expect(screen.getByText("Available on the Business plan and above.")).toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByText(/Inbound/)).not.toBeInTheDocument();
    expect(api.getWhatsAppWebhookInfo).not.toHaveBeenCalled();
    expect(api.getWhatsAppMessages).not.toHaveBeenCalled();
  });
});
