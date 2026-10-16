// The "Before you connect" notice: it opens on every attempt to connect the customer's OWN X keys or OWN WhatsApp (Meta) token,
// before anything is sent. Continue sends the request once; Cancel, Escape and a click on the backdrop send nothing.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({
  checkXKeys: vi.fn(),
  connectXKeys: vi.fn(),
  checkWhatsAppCredentials: vi.fn(),
  connectWhatsAppCredentials: vi.fn(),
}));
vi.mock("../../lib/api", () => ({ api }));

import { CustomPlatformSettings } from "./CustomPlatformSettings";
import { ConnectX } from "../../pages/ConnectX";
import { ByokDisclaimerModal } from "../ByokDisclaimerModal";
import { BYOK_DISCLAIMER_TEXT, BYOK_DISCLAIMER_TITLE } from "../../lib/byokDisclaimer";
import type { PlatformInfo } from "../../lib/api";
// The frontend has no Node typings (tsc -b checks test files too), so the files this reads come in with Vite's ?raw import.
import modalSource from "../ByokDisclaimerModal.tsx?raw";
import textSource from "../../lib/byokDisclaimer.ts?raw";
import css from "../../styles/byok-disclaimer.css?raw";

// Werner's wording, typed out again here on purpose: if the shared constant is ever edited, this fails.
const APPROVED =
  "Please verify the limits, throttling constraints, and coverage of your respective Meta Developer or X Developer plans. LazyRelay does not control, limit, or throttle usage on these external platforms.";

// En-dash and em-dash, built from code points so no literal dash sits in this file.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

const X_OK: PlatformInfo = { platform: "x", configured: true, comingSoon: false, requiresPlan: "Starter", allowed: true };
const WA_OK: PlatformInfo = { platform: "whatsapp", configured: true, comingSoon: false, requiresPlan: "Starter", allowed: true };
// Fake values that merely look the right shape. None is a real credential.
const FAKE_X = { apiKey: "fakeApiKey12345", apiSecret: "fakeApiSecret12345", accessToken: "99-fakeAccessToken123", accessTokenSecret: "fakeTokenSecret12345" };
const FAKE_WA = { wabaId: "123456789012345", phoneNumberId: "109876543210987", systemUserToken: "test_whatsapp_system_user_token_not_real_0123456789" };

type User = ReturnType<typeof userEvent.setup>;
const CONTINUE = () => screen.getByRole("button", { name: "Continue" });
const CANCEL = () => screen.getByRole("button", { name: "Cancel" });
const dialog = () => screen.getByRole("dialog", { name: BYOK_DISCLAIMER_TITLE });
const noDialog = () => expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
const anyRequest = () => Object.values(api).reduce((n, fn) => n + fn.mock.calls.length, 0);

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

async function fillX(user: User) {
  await user.type(screen.getByLabelText("API Key (Consumer Key)"), FAKE_X.apiKey);
  await user.type(screen.getByLabelText("API Secret (Consumer Secret)"), FAKE_X.apiSecret);
  await user.type(screen.getByLabelText("Access Token"), FAKE_X.accessToken);
  await user.type(screen.getByLabelText("Access Token Secret"), FAKE_X.accessTokenSecret);
  await user.click(screen.getByRole("checkbox"));
}
async function fillWa(user: User) {
  await user.type(screen.getByLabelText("WABA ID"), FAKE_WA.wabaId);
  await user.type(screen.getByLabelText("Phone number ID"), FAKE_WA.phoneNumberId);
  await user.type(screen.getByLabelText("System user token"), FAKE_WA.systemUserToken);
  await user.click(screen.getByRole("checkbox"));
}

describe("the notice itself", () => {
  it("carries Werner's sentence word for word, with a neutral title that contradicts nothing", () => {
    expect(BYOK_DISCLAIMER_TEXT).toBe(APPROVED);
    render(<ByokDisclaimerModal onContinue={() => {}} onCancel={() => {}} />);
    expect(dialog()).toHaveTextContent(APPROVED);
    expect(screen.getByText(APPROVED).tagName).toBe("P");
    expect(BYOK_DISCLAIMER_TITLE).toBe("Before you connect");
  });

  it("is a labelled, described, modal dialog", () => {
    render(<ByokDisclaimerModal onContinue={() => {}} onCancel={() => {}} />);
    const d = dialog();
    expect(d).toHaveAttribute("role", "dialog");
    expect(d).toHaveAttribute("aria-modal", "true");
    expect(d).toHaveAccessibleName("Before you connect");
    expect(d).toHaveAccessibleDescription(APPROVED);
    expect(within(d).getAllByRole("button").map((b) => b.tagName)).toEqual(["BUTTON", "BUTTON"]);
  });

  it("moves focus into the dialog when it opens", () => {
    render(<ByokDisclaimerModal onContinue={() => {}} onCancel={() => {}} />);
    expect(dialog()).toHaveFocus();
  });

  it("keeps Tab and Shift+Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(<ByokDisclaimerModal onContinue={() => {}} onCancel={() => {}} />);
    await user.tab();
    expect(CONTINUE()).toHaveFocus();
    await user.tab();
    expect(CANCEL()).toHaveFocus();
    await user.tab();
    expect(CONTINUE()).toHaveFocus(); // wrapped round
    await user.tab({ shift: true });
    expect(CANCEL()).toHaveFocus(); // and back the other way
  });

  it("Continue continues once; Cancel, Escape and the backdrop cancel; a click inside the card does not", async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    const onCancel = vi.fn();
    const { baseElement } = render(<ByokDisclaimerModal onContinue={onContinue} onCancel={onCancel} />);
    await user.click(dialog());
    await user.click(screen.getByText(APPROVED));
    expect(onCancel).not.toHaveBeenCalled();
    await user.click(CANCEL());
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
    await user.click(baseElement.querySelector(".byok-disclaimer__overlay") as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onContinue).not.toHaveBeenCalled();
    await user.click(CONTINUE());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});

describe("X (Settings, Custom developer keys)", () => {
  it("opens on Save and connect, before any request, with the exact sentence", async () => {
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[X_OK]} />);
    await fillX(user);
    noDialog();
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    expect(dialog()).toHaveTextContent(APPROVED);
    expect(anyRequest()).toBe(0);
  });

  it("opens on Check my keys too, because that also sends the keys", async () => {
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[X_OK]} />);
    await fillX(user);
    await user.click(screen.getByRole("button", { name: "Check my keys" }));
    expect(dialog()).toBeInTheDocument();
    expect(anyRequest()).toBe(0);
  });

  it("Cancel, Escape and the backdrop send nothing, close it, keep the typed keys and hand focus back to the button", async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<CustomPlatformSettings platforms={[X_OK]} />);
    await fillX(user);
    const save = screen.getByRole("button", { name: "Save and connect" });
    for (const close of [() => user.click(CANCEL()), () => user.keyboard("{Escape}"), () => user.click(baseElement.querySelector(".byok-disclaimer__overlay") as HTMLElement)]) {
      await user.click(save);
      expect(dialog()).toBeInTheDocument();
      await close();
      noDialog();
      expect(anyRequest()).toBe(0);
      expect(save).toHaveFocus();
    }
    expect(screen.getByLabelText("API Key (Consumer Key)")).toHaveValue(FAKE_X.apiKey);
  });

  it("Continue sends the request exactly once, and the notice asks again on the next attempt", async () => {
    api.connectXKeys.mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[X_OK]} />);
    await fillX(user);
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await user.click(CONTINUE());
    noDialog();
    await waitFor(() => expect(api.connectXKeys).toHaveBeenCalledTimes(1));
    await screen.findByRole("alert");
    // the failed save cleared the secrets; type them again and try again: the notice is back
    await user.type(screen.getByLabelText("API Secret (Consumer Secret)"), FAKE_X.apiSecret);
    await user.type(screen.getByLabelText("Access Token"), FAKE_X.accessToken);
    await user.type(screen.getByLabelText("Access Token Secret"), FAKE_X.accessTokenSecret);
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    expect(dialog()).toBeInTheDocument();
    expect(api.connectXKeys).toHaveBeenCalledTimes(1);
  });

  it("Continue on a check sends the check once and saves nothing", async () => {
    api.checkXKeys.mockResolvedValue({ ok: true, handle: "acme", keyHint: "****2345" });
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[X_OK]} />);
    await fillX(user);
    await user.click(screen.getByRole("button", { name: "Check my keys" }));
    await user.click(CONTINUE());
    await waitFor(() => expect(api.checkXKeys).toHaveBeenCalledTimes(1));
    expect(api.connectXKeys).not.toHaveBeenCalled();
  });

  it("a locked (Free or lapsed) account has no form, so no notice and no request", async () => {
    render(<CustomPlatformSettings platforms={[{ ...X_OK, allowed: false }]} />);
    expect(screen.queryByRole("button", { name: "Save and connect" })).not.toBeInTheDocument();
    noDialog();
  });
});

describe("WhatsApp (Settings, Custom developer keys)", () => {
  it("opens on Save and connect, before any request, with the exact sentence", async () => {
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    await fillWa(user);
    noDialog();
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    expect(dialog()).toHaveTextContent(APPROVED);
    expect(anyRequest()).toBe(0);
  });

  it("opens on Check my credentials too, because that also sends the token", async () => {
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    await fillWa(user);
    await user.click(screen.getByRole("button", { name: "Check my credentials" }));
    expect(dialog()).toBeInTheDocument();
    expect(anyRequest()).toBe(0);
  });

  it("Cancel, Escape and the backdrop send nothing, close it, keep the token and hand focus back to the button", async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<CustomPlatformSettings platforms={[WA_OK]} />);
    await fillWa(user);
    const save = screen.getByRole("button", { name: "Save and connect" });
    for (const close of [() => user.click(CANCEL()), () => user.keyboard("{Escape}"), () => user.click(baseElement.querySelector(".byok-disclaimer__overlay") as HTMLElement)]) {
      await user.click(save);
      expect(dialog()).toBeInTheDocument();
      await close();
      noDialog();
      expect(anyRequest()).toBe(0);
      expect(save).toHaveFocus();
    }
    expect(screen.getByLabelText("System user token")).toHaveValue(FAKE_WA.systemUserToken);
  });

  it("Continue sends the request exactly once, and the notice asks again on the next attempt", async () => {
    api.connectWhatsAppCredentials.mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    await fillWa(user);
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await user.click(CONTINUE());
    noDialog();
    await waitFor(() => expect(api.connectWhatsAppCredentials).toHaveBeenCalledTimes(1));
    await screen.findByRole("alert");
    await user.type(screen.getByLabelText("System user token"), FAKE_WA.systemUserToken);
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    expect(dialog()).toBeInTheDocument();
    expect(api.connectWhatsAppCredentials).toHaveBeenCalledTimes(1);
  });

  it("a locked (Free or lapsed) account has no form, so no notice and no request", () => {
    render(<CustomPlatformSettings platforms={[{ ...WA_OK, allowed: false }]} />);
    expect(screen.queryByRole("button", { name: "Save and connect" })).not.toBeInTheDocument();
    noDialog();
  });
});

describe("X (the Connect X page)", () => {
  async function fillPage(user: User) {
    await user.type(screen.getByLabelText(/^API Key/), FAKE_X.apiKey);
    await user.type(screen.getByLabelText(/^API Secret/), FAKE_X.apiSecret);
    await user.type(screen.getByLabelText(/^Access Token$/), FAKE_X.accessToken);
    await user.type(screen.getByLabelText(/^Access Token Secret/), FAKE_X.accessTokenSecret);
    await user.click(screen.getByRole("checkbox"));
  }

  it("opens before any request; Cancel sends nothing; Continue sends once", async () => {
    api.connectXKeys.mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();
    render(<ConnectX />);
    await fillPage(user);
    const save = screen.getByRole("button", { name: "Save and connect" });
    await user.click(save);
    expect(dialog()).toHaveTextContent(APPROVED);
    expect(anyRequest()).toBe(0);
    await user.click(CANCEL());
    noDialog();
    expect(anyRequest()).toBe(0);
    expect(save).toHaveFocus();
    await user.click(save);
    await user.click(CONTINUE());
    await waitFor(() => expect(api.connectXKeys).toHaveBeenCalledTimes(1));
  });

  it("opens on Check my keys too", async () => {
    const user = userEvent.setup();
    render(<ConnectX />);
    await fillPage(user);
    await user.click(screen.getByRole("button", { name: "Check my keys" }));
    expect(dialog()).toBeInTheDocument();
    expect(anyRequest()).toBe(0);
  });
});

describe("the source of the notice", () => {
  it("has no em dash or en dash in its own text, code or styles", () => {
    for (const src of [modalSource, textSource, css]) expect(src).not.toMatch(DASHES);
  });

  it("holds Werner's sentence exactly once, in one shared constant", () => {
    expect(textSource).toContain(APPROVED);
    expect(modalSource).not.toContain("throttl");
  });

  it("respects reduced motion and reduced transparency, and animates only opacity and transform", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[^}]*\{[^}]*animation: none/);
    expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\)/);
    expect(css).toMatch(/backdrop-filter: none/);
    const keyframes = [...css.matchAll(/@keyframes[^{]*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)].map((m) => m[1]).join("\n");
    expect(keyframes).toMatch(/opacity/);
    expect(keyframes).toMatch(/transform/);
    expect(keyframes).not.toMatch(/\b(width|height|margin|padding|top|left|right|bottom)\s*:/);
  });

  it("uses the existing midnight, slate and coral tokens and works at phone width", () => {
    expect(css).toContain("#0b0f19");
    expect(css).toContain("#141b2d");
    expect(css).toContain("#ff5630");
    expect(css).toMatch(/padding: 16px/);
    expect(css).toMatch(/max-width: 440px/);
    expect(css).toMatch(/max-height: calc\(100dvh - 32px\)/);
    expect(css).toMatch(/flex-direction: column/);
  });
});
