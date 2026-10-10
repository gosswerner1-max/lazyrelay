import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({
  checkXKeys: vi.fn(),
  connectXKeys: vi.fn(),
  checkWhatsAppCredentials: vi.fn(),
  connectWhatsAppCredentials: vi.fn(),
}));
vi.mock("../../lib/api", () => ({ api }));

import { CustomPlatformSettings } from "./CustomPlatformSettings";
import { X_BYOK_CONSENT_TEXT, X_BYOK_GUIDE_URL } from "../../lib/xByok";
import { WHATSAPP_BYOK_CONSENT_TEXT, whatsAppFieldErrors, whatsAppFieldsComplete } from "../../lib/whatsappByok";
import type { PlatformInfo } from "../../lib/api";
// The frontend has no Node typings (tsc -b checks test files too), so the two files this reads come in with Vite's ?raw import.
import css from "../../styles/byok-panels.css?raw";
import componentSource from "./CustomPlatformSettings.tsx?raw";

// The exact words Werner approved for X, typed out again here on purpose: if the shared constant is ever edited, this fails.
const X_APPROVED =
  "I understand that by using my own custom keys, all publishing and media upload charges are billed directly to my personal X developer wallet according to X's pay-per-use consumption rates. I accept full responsibility for managing my own credit balance and agree to X's Developer terms.";
// NOT legal wording. A stand-in string so the WhatsApp save flow can be exercised while the real text is unwritten.
const TEST_ONLY_CONSENT = "TEST ONLY consent stand-in, not approved wording.";

const X_OK: PlatformInfo = { platform: "x", configured: true, comingSoon: false, requiresPlan: "Pro", allowed: true };
const WA_OK: PlatformInfo = { platform: "whatsapp", configured: true, comingSoon: false, requiresPlan: "Business", allowed: true };

// Fake values that merely look the right shape. None is a real credential.
const FAKE_X = { apiKey: "fakeApiKey12345", apiSecret: "fakeApiSecret12345", accessToken: "99-fakeAccessToken123", accessTokenSecret: "fakeTokenSecret12345" };
const FAKE_WA = { wabaId: "123456789012345", phoneNumberId: "109876543210987", systemUserToken: "test_whatsapp_system_user_token_not_real_0123456789" };

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const everyStoredValue = () => JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }]);

describe("what shows, decided by the platform list the backend sends", () => {
  it("renders nothing at all when neither X nor WhatsApp is listed (feature switches off)", () => {
    const { container } = render(<CustomPlatformSettings platforms={[{ platform: "mastodon", configured: true, comingSoon: false }]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows only the platform that is listed", () => {
    const { rerender } = render(<CustomPlatformSettings platforms={[X_OK]} />);
    expect(screen.getByLabelText("API Key (Consumer Key)")).toBeInTheDocument();
    expect(screen.queryByLabelText(/System user token/)).not.toBeInTheDocument();
    rerender(<CustomPlatformSettings platforms={[WA_OK]} />);
    expect(screen.getByLabelText("System user token")).toBeInTheDocument();
    expect(screen.queryByLabelText("API Key (Consumer Key)")).not.toBeInTheDocument();
  });

  it("lays the two cards out side by side only when both are listed", () => {
    const { container, rerender } = render(<CustomPlatformSettings platforms={[X_OK, WA_OK]} />);
    expect(container.querySelector(".byok-panels__grid--two")).not.toBeNull();
    rerender(<CustomPlatformSettings platforms={[X_OK]} />);
    expect(container.querySelector(".byok-panels__grid--two")).toBeNull();
  });

  it("a plan that is not allowed gets the upgrade note and NO form fields", () => {
    render(<CustomPlatformSettings platforms={[{ ...X_OK, allowed: false }, { ...WA_OK, allowed: false }]} />);
    expect(screen.getByText("Available on the Pro plan and above.")).toBeInTheDocument();
    expect(screen.getByText("Available on the Business plan and above.")).toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Save and connect/ })).not.toBeInTheDocument();
  });
});

describe("X: the exact consent text and the guide link", () => {
  it("the shared constant is exactly the approved wording, and has no curly quotes or dashes", () => {
    expect(X_BYOK_CONSENT_TEXT).toBe(X_APPROVED);
    expect(X_BYOK_CONSENT_TEXT).not.toMatch(/[‘’—–]/);
  });

  it("the approved wording appears byte for byte in the rendered panel, next to a checkbox", () => {
    const { container } = render(<CustomPlatformSettings platforms={[X_OK]} />);
    expect(container.innerHTML).toContain(X_APPROVED);
    const box = screen.getByRole("checkbox");
    expect(box.closest("label")).toHaveTextContent(X_APPROVED);
  });

  it("links straight to the live setup guide, opening in a new tab safely", () => {
    render(<CustomPlatformSettings platforms={[X_OK]} />);
    const link = screen.getByRole("link", { name: /setup guide/i });
    expect(link).toHaveAttribute("href", X_BYOK_GUIDE_URL);
    expect(X_BYOK_GUIDE_URL).toBe("/guides/x-developer-keys/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
    expect(link.getAttribute("rel")).toMatch(/noreferrer/);
  });
});

describe("X: the form", () => {
  async function fillX(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText("API Key (Consumer Key)"), FAKE_X.apiKey);
    await user.type(screen.getByLabelText("API Secret (Consumer Secret)"), FAKE_X.apiSecret);
    await user.type(screen.getByLabelText("Access Token"), FAKE_X.accessToken);
    await user.type(screen.getByLabelText("Access Token Secret"), FAKE_X.accessTokenSecret);
  }
  const save = () => screen.getByRole("button", { name: "Save and connect" });

  it("the two secrets are hidden until the customer asks to see them", async () => {
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[X_OK]} />);
    const secret = screen.getByLabelText("API Secret (Consumer Secret)") as HTMLInputElement;
    expect(secret.type).toBe("password");
    expect((screen.getByLabelText("Access Token Secret") as HTMLInputElement).type).toBe("password");
    expect((screen.getByLabelText("API Key (Consumer Key)") as HTMLInputElement).type).toBe("text");
    await user.click(screen.getByRole("button", { name: "Show API Secret (Consumer Secret)" }));
    expect(secret.type).toBe("text");
  });

  it("Save stays off until all four are filled AND the box is ticked", async () => {
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[X_OK]} />);
    expect(save()).toBeDisabled();
    await fillX(user);
    expect(save()).toBeDisabled(); // box not ticked
    await user.click(screen.getByRole("checkbox"));
    expect(save()).toBeEnabled();
    await user.clear(screen.getByLabelText("Access Token"));
    expect(save()).toBeDisabled();
  });

  it("sends the four trimmed keys once, clears the secrets and reports the connection", async () => {
    api.connectXKeys.mockResolvedValue({ ok: true, handle: "acme", keyHint: "****2345" });
    const onConnected = vi.fn();
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[X_OK]} onConnected={onConnected} />);
    await fillX(user);
    await user.click(screen.getByRole("checkbox"));
    await user.click(save());
    await waitFor(() => expect(api.connectXKeys).toHaveBeenCalledTimes(1));
    expect(api.connectXKeys).toHaveBeenCalledWith(FAKE_X);
    expect(await screen.findByText("Connected as @acme.")).toBeInTheDocument();
    expect(onConnected).toHaveBeenCalledWith("x");
    expect((screen.getByLabelText("API Secret (Consumer Secret)") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Access Token Secret") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("API Key (Consumer Key)") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("clears the secrets and shows the error when the backend refuses", async () => {
    api.connectXKeys.mockRejectedValue(new Error("X did not accept these keys."));
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[X_OK]} />);
    await fillX(user);
    await user.click(screen.getByRole("checkbox"));
    await user.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("X did not accept these keys.");
    expect((screen.getByLabelText("API Secret (Consumer Secret)") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Access Token Secret") as HTMLInputElement).value).toBe("");
  });

  it("Check proves the keys without saving anything", async () => {
    api.checkXKeys.mockResolvedValue({ ok: true, handle: "acme", keyHint: "****2345" });
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[X_OK]} />);
    await fillX(user);
    await user.click(screen.getByRole("button", { name: "Check my keys" }));
    expect(await screen.findByText(/They belong to @acme/)).toBeInTheDocument();
    expect(api.checkXKeys).toHaveBeenCalledWith(FAKE_X);
    expect(api.connectXKeys).not.toHaveBeenCalled();
  });

  it("never writes a key to localStorage or sessionStorage", async () => {
    api.connectXKeys.mockResolvedValue({ ok: true, handle: "acme", keyHint: "****2345" });
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[X_OK]} />);
    await fillX(user);
    await user.click(screen.getByRole("checkbox"));
    await user.click(save());
    await screen.findByText("Connected as @acme.");
    const stored = everyStoredValue();
    for (const v of Object.values(FAKE_X)) expect(stored).not.toContain(v);
  });
});

describe("WhatsApp: the form", () => {
  async function fillWa(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText("WhatsApp Business Account ID (WABA ID)"), FAKE_WA.wabaId);
    await user.type(screen.getByLabelText("Phone number ID"), FAKE_WA.phoneNumberId);
    await user.type(screen.getByLabelText("System user token"), FAKE_WA.systemUserToken);
  }
  const save = () => screen.getByRole("button", { name: "Save and connect" });

  it("the WhatsApp consent wording is NOT written yet: it is null, and nothing here invents it", () => {
    expect(WHATSAPP_BYOK_CONSENT_TEXT).toBeNull();
  });

  it("while the wording is missing there is no checkbox, saving is off even when everything is filled, and the page says why", async () => {
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    await fillWa(user);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(save()).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent(/consent wording for WhatsApp is not published yet/i);
    expect(screen.getByRole("button", { name: "Check my credentials" })).toBeEnabled(); // checking stores nothing
  });

  it("says plainly that publishing to WhatsApp is not available yet", () => {
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    expect(screen.getByText(/Publishing to WhatsApp is not available yet/)).toBeInTheDocument();
  });

  it("the token is hidden until the customer asks to see it", async () => {
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    const token = screen.getByLabelText("System user token") as HTMLInputElement;
    expect(token.type).toBe("password");
    await user.click(screen.getByRole("button", { name: "Show System user token" }));
    expect(token.type).toBe("text");
  });

  it("flags wrong input in plain words and keeps Check and Save off", async () => {
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} whatsappConsentText={TEST_ONLY_CONSENT} />);
    await user.type(screen.getByLabelText("WhatsApp Business Account ID (WABA ID)"), "abc12345");
    await user.type(screen.getByLabelText("Phone number ID"), "+27 82 000 0000");
    await user.type(screen.getByLabelText("System user token"), "short");
    expect(screen.getByText(/numeric ID from Meta: digits only/)).toBeInTheDocument();
    expect(screen.getByText(/not the phone number itself/)).toBeInTheDocument();
    expect(screen.getByText(/does not look like a whole system user token/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check my credentials" })).toBeDisabled();
    expect(save()).toBeDisabled();
  });

  it("with the wording supplied: Save needs the box, sends the trimmed values once, then clears the token", async () => {
    api.connectWhatsAppCredentials.mockResolvedValue({ ok: true, displayName: "Acme Cafe", keyHint: "****0987" });
    const onConnected = vi.fn();
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} whatsappConsentText={TEST_ONLY_CONSENT} onConnected={onConnected} />);
    await fillWa(user);
    expect(save()).toBeDisabled();
    const box = screen.getByRole("checkbox");
    expect(box.closest("label")).toHaveTextContent(TEST_ONLY_CONSENT);
    await user.click(box);
    expect(save()).toBeEnabled();
    await user.click(save());
    await waitFor(() => expect(api.connectWhatsAppCredentials).toHaveBeenCalledTimes(1));
    expect(api.connectWhatsAppCredentials).toHaveBeenCalledWith(FAKE_WA);
    expect(await screen.findByText("Connected as Acme Cafe.")).toBeInTheDocument();
    expect(onConnected).toHaveBeenCalledWith("whatsapp");
    expect((screen.getByLabelText("System user token") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Phone number ID") as HTMLInputElement).value).toBe("");
  });

  it("clears the token and shows the error when the backend refuses (a plan below Business answers 400)", async () => {
    api.connectWhatsAppCredentials.mockRejectedValue(new Error("Connecting WhatsApp with your own Meta credentials is available on the Business plan and above."));
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} whatsappConsentText={TEST_ONLY_CONSENT} />);
    await fillWa(user);
    await user.click(screen.getByRole("checkbox"));
    await user.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Business plan and above/);
    expect((screen.getByLabelText("System user token") as HTMLInputElement).value).toBe("");
  });

  it("Check proves the credentials without saving anything", async () => {
    api.checkWhatsAppCredentials.mockResolvedValue({ ok: true, displayName: "Acme Cafe", keyHint: "****0987" });
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    await fillWa(user);
    await user.click(screen.getByRole("button", { name: "Check my credentials" }));
    expect(await screen.findByText("Credentials accepted for Acme Cafe.")).toBeInTheDocument();
    expect(api.checkWhatsAppCredentials).toHaveBeenCalledWith(FAKE_WA);
    expect(api.connectWhatsAppCredentials).not.toHaveBeenCalled();
  });

  it("never writes the token or the ids to localStorage or sessionStorage", async () => {
    api.connectWhatsAppCredentials.mockResolvedValue({ ok: true, displayName: null, keyHint: "****0987" });
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} whatsappConsentText={TEST_ONLY_CONSENT} />);
    await fillWa(user);
    await user.click(screen.getByRole("checkbox"));
    await user.click(save());
    await screen.findByText("Connected.");
    const stored = everyStoredValue();
    for (const v of Object.values(FAKE_WA)) expect(stored).not.toContain(v);
  });
});

describe("the field rules match the backend", () => {
  it("ids are 5 to 25 digits; a token is 20 to 512 characters of letters, digits, dot, dash, underscore", () => {
    expect(whatsAppFieldsComplete(FAKE_WA)).toBe(true);
    for (const wabaId of ["", "1234", "12 34 56 78", "abcdefgh", "1".repeat(26)]) expect(whatsAppFieldsComplete({ ...FAKE_WA, wabaId }), wabaId).toBe(false);
    for (const systemUserToken of ["", "short", "has spaces in the token value 0123456789", "a".repeat(513)]) expect(whatsAppFieldsComplete({ ...FAKE_WA, systemUserToken }), systemUserToken).toBe(false);
    expect(whatsAppFieldErrors({ wabaId: "", phoneNumberId: "", systemUserToken: "" })).toEqual({}); // untouched fields are not "wrong"
  });
});

describe("the stylesheet cannot leak into the rest of the dashboard", () => {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("every selector belongs to .byok-panels, .byok-card or another .byok- class: nothing global", () => {
    const blocks = noComments.split("}").map((b) => b.split("{")[0].trim()).filter(Boolean);
    const selectors = blocks.filter((s) => !s.startsWith("@") && !/^\d+%$|^(from|to)$/.test(s)).flatMap((s) => s.split(",").map((x) => x.trim()));
    expect(selectors.length).toBeGreaterThan(20);
    for (const sel of selectors) expect(sel, sel).toMatch(/^\.byok-/);
    expect(noComments).not.toMatch(/(^|[\s,{}])(:root|html|body)\b/);
  });

  it("carries the brand tokens: midnight, slate and coral", () => {
    expect(css).toMatch(/#0b0f19/i);
    expect(css).toMatch(/#141b2d/i);
    expect(css).toMatch(/#ff5630/i);
    expect(css).toMatch(/blur\(12px\)/);
    expect(css).toMatch(/rgba\(255, 86, 48/);
  });

  it("has no flat white background anywhere", () => {
    expect(noComments).not.toMatch(/background(-color)?:\s*(#fff\b|#ffffff\b|white\b)/i);
  });

  it("is imported by the panel component itself, so it loads only where the panel is used", () => {
    expect(componentSource).toContain('import "../../styles/byok-panels.css"');
  });
});
