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
// The exact words Werner approved for WhatsApp (2026-10-10), typed out again here on purpose: if the shared constant is ever edited, this fails.
const WA_APPROVED =
  "I understand that custom WhatsApp messaging requires active payment credentials linked directly to my Meta Business portfolio. All conversational template billing is handled by Meta directly. I accept full responsibility for compliance with Meta's Business Policies.";

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

  it("a locked card offers See plans, which calls the Settings view's own way to the Plan & billing sub-tab", async () => {
    const onSeePlans = vi.fn();
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[{ ...X_OK, allowed: false }, { ...WA_OK, allowed: false }]} onSeePlans={onSeePlans} />);
    const buttons = screen.getAllByRole("button", { name: "See plans" });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]);
    await user.click(buttons[1]);
    expect(onSeePlans).toHaveBeenCalledTimes(2);
  });

  it("an unlocked card has no See plans button", () => {
    render(<CustomPlatformSettings platforms={[X_OK, WA_OK]} onSeePlans={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "See plans" })).not.toBeInTheDocument();
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

  it("the three secrets (API Secret, Access Token, Access Token Secret) are hidden until the customer asks to see them", async () => {
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[X_OK]} />);
    const secret = screen.getByLabelText("API Secret (Consumer Secret)") as HTMLInputElement;
    expect(secret.type).toBe("password");
    expect((screen.getByLabelText("Access Token Secret") as HTMLInputElement).type).toBe("password");
    const accessToken = screen.getByLabelText("Access Token") as HTMLInputElement;
    expect(accessToken.type).toBe("password");
    expect(accessToken.autocomplete).toBe("off");
    expect((screen.getByLabelText("API Key (Consumer Key)") as HTMLInputElement).type).toBe("text"); // an identifier, not a secret
    await user.click(screen.getByRole("button", { name: "Show API Secret (Consumer Secret)" }));
    expect(secret.type).toBe("text");
    await user.click(screen.getByRole("button", { name: "Show Access Token" }));
    expect(accessToken.type).toBe("text");
    await user.click(screen.getByRole("button", { name: "Hide Access Token" }));
    expect(accessToken.type).toBe("password");
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
    expect((screen.getByLabelText("Access Token") as HTMLInputElement).value).toBe("");
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
    expect((screen.getByLabelText("Access Token") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Access Token") as HTMLInputElement).type).toBe("password"); // hiding is reset too
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
    await user.type(screen.getByLabelText("WABA ID"), FAKE_WA.wabaId);
    await user.type(screen.getByLabelText("Phone number ID"), FAKE_WA.phoneNumberId);
    await user.type(screen.getByLabelText("System user token"), FAKE_WA.systemUserToken);
  }
  const save = () => screen.getByRole("button", { name: "Save and connect" });

  it("the shared constant is exactly the approved wording, with a straight apostrophe and no dashes", () => {
    expect(WHATSAPP_BYOK_CONSENT_TEXT).toBe(WA_APPROVED);
    expect(WHATSAPP_BYOK_CONSENT_TEXT).not.toMatch(/[‘’—–]/);
  });

  it("the approved wording appears byte for byte in the rendered panel, next to a checkbox", () => {
    const { container } = render(<CustomPlatformSettings platforms={[WA_OK]} />);
    expect(container.innerHTML).toContain(WA_APPROVED);
    expect(screen.getByRole("checkbox").closest("label")).toHaveTextContent(WA_APPROVED);
  });

  it("saving stays off until everything is filled AND the box is ticked; checking needs no box", async () => {
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    expect(save()).toBeDisabled();
    await fillWa(user);
    expect(save()).toBeDisabled(); // box not ticked
    expect(screen.getByRole("button", { name: "Check my credentials" })).toBeEnabled(); // checking stores nothing
    await user.click(screen.getByRole("checkbox"));
    expect(save()).toBeEnabled();
  });

  it("says plainly that publishing to WhatsApp is not available yet", () => {
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    expect(screen.getByText(/Publishing to WhatsApp is not available yet/)).toBeInTheDocument();
  });

  it("says in one plain sentence, between the consent box and the buttons, that sending is not available yet", () => {
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    const sentence = screen.getByText("WhatsApp sending is not available yet. Saving only stores your connection.");
    expect(sentence.textContent).not.toMatch(/[\u2018\u2019\u2013\u2014-]/);
    const consent = screen.getByRole("checkbox").closest("label") as HTMLElement;
    const save = screen.getByRole("button", { name: "Save and connect" });
    expect(consent.compareDocumentPosition(sentence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sentence.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("uses a short WABA ID label so the two ID fields line up when the label would wrap", () => {
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    expect(screen.getByLabelText("WABA ID")).toHaveAttribute("placeholder", "WhatsApp Business Account ID");
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
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    await user.type(screen.getByLabelText("WABA ID"), "abc12345");
    await user.type(screen.getByLabelText("Phone number ID"), "+27 82 000 0000");
    await user.type(screen.getByLabelText("System user token"), "short");
    expect(screen.getByText(/numeric ID from Meta: digits only/)).toBeInTheDocument();
    expect(screen.getByText(/not the phone number itself/)).toBeInTheDocument();
    expect(screen.getByText(/does not look like a whole system user token/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check my credentials" })).toBeDisabled();
    expect(save()).toBeDisabled();
  });

  it("Save needs the box, sends the trimmed values once, then clears the token", async () => {
    api.connectWhatsAppCredentials.mockResolvedValue({ ok: true, displayName: "Acme Cafe", keyHint: "****0987" });
    const onConnected = vi.fn();
    const user = userEvent.setup();
    render(<CustomPlatformSettings platforms={[WA_OK]} onConnected={onConnected} />);
    await fillWa(user);
    expect(save()).toBeDisabled();
    const box = screen.getByRole("checkbox");
    expect(box.closest("label")).toHaveTextContent(WA_APPROVED);
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
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
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
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
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

  interface Rule {
    /** The selector list of a style rule, or the at-rule header (e.g. "@media (min-width: 640px)") */
    prelude: string;
    body: string;
    children: Rule[];
  }
  /** A small brace parser: enough for plain CSS with nested @media / @supports blocks. */
  function parse(text: string): Rule[] {
    const out: Rule[] = [];
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let k = open + 1;
      while (k < text.length && depth > 0) {
        if (text[k] === "{") depth++;
        else if (text[k] === "}") depth--;
        k++;
      }
      const inner = text.slice(open + 1, k - 1);
      const isGroup = /^@(media|supports|layer|container)\b/.test(prelude);
      out.push({ prelude, body: isGroup ? "" : inner, children: isGroup ? parse(inner) : [] });
      i = k;
    }
    return out;
  }
  const flat = (rules: Rule[]): Rule[] => rules.flatMap((r) => [r, ...flat(r.children)]);
  const all = flat(parse(noComments));
  const styleRules = all.filter((r) => !r.prelude.startsWith("@"));
  const selectors = styleRules.flatMap((r) => r.prelude.split(",").map((x) => x.trim()));

  it("parses the whole file into style rules (a sanity check on the parser itself)", () => {
    expect(styleRules.length).toBeGreaterThan(40);
    expect(all.some((r) => r.prelude.startsWith("@media") && r.children.length > 0)).toBe(true);
    expect(all.some((r) => r.prelude.startsWith("@supports") && r.children.length > 0)).toBe(true);
  });

  it("every selector, including those inside @media and @supports, is the .byok-panels root or sits under it", () => {
    for (const sel of selectors) expect(sel, sel).toMatch(/^\.byok-panels(?![\w-])/);
  });

  it("has no :root, html, body or universal rule anywhere, and no unprefixed @keyframes", () => {
    for (const sel of selectors) {
      expect(sel, sel).not.toMatch(/(^|[\s>+~(,])(:root|html|body)(?![\w-])/);
      expect(sel, sel).not.toMatch(/(^|[\s>+~(,])\*/);
    }
    for (const r of all.filter((x) => /^@(-webkit-)?keyframes\b/.test(x.prelude))) expect(r.prelude, r.prelude).toMatch(/^@(-webkit-)?keyframes\s+byok-/);
    expect(noComments).not.toMatch(/@font-face|@import|@property/);
  });

  it("carries the brand tokens: midnight, slate and coral", () => {
    expect(css).toMatch(/#0b0f19/i);
    expect(css).toMatch(/#141b2d/i);
    expect(css).toMatch(/#ff5630/i);
    expect(css).toMatch(/blur\(12px\)/);
    expect(css).toMatch(/rgba\(255, 86, 48/);
  });

  it("has no flat white (#fff, #ffffff, white, Canvas) in any background declaration", () => {
    const declarations = styleRules.flatMap((r) => r.body.split(";").map((d) => d.trim()));
    const backgrounds = declarations.filter((d) => /^background[\w-]*\s*:/i.test(d));
    expect(backgrounds.length).toBeGreaterThan(5);
    for (const d of backgrounds) {
      expect(d, d).not.toMatch(/#fff(fff)?\b|\bwhite\b|\bcanvas\b|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(,\s*1(\.0+)?\s*)?\)/i);
    }
  });

  it("the cards and the secondary and show buttons get the coral hover shadow, and reduced motion switches it off", () => {
    expect(noComments).toMatch(/\.byok-panels \.byok-card:hover\s*\{[^}]*box-shadow:[^;}]*255, 86, 48/);
    expect(noComments).toMatch(/\.byok-panels \.byok-actions \.byok-secondary:hover:not\(:disabled\)\s*\{[^}]*box-shadow:[^;}]*255, 86, 48/);
    expect(noComments).toMatch(/\.byok-panels \.byok-reveal:hover\s*\{[^}]*box-shadow:[^;}]*255, 86, 48/);
    const reduced = all.find((r) => r.prelude.startsWith("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toBeDefined();
    const text = JSON.stringify(reduced!.children);
    expect(text).toContain(".byok-reveal:hover");
    expect(text).toContain(".byok-secondary:hover:not(:disabled)");
    expect(text).toContain(".byok-card:hover:not(:focus-within)");
  });

  it("the field, button and card borders use the lighter slate edge, not the old 12% white or 28% coral lines", () => {
    expect(css).toMatch(/--byok-edge:\s*#5d6c8c/i);
    expect(noComments).not.toMatch(/--byok-line/);
    const checked = styleRules.filter((r) => /^\.byok-panels \.byok-(field input|reveal|consent|card|actions \.byok-secondary)$/.test(r.prelude));
    expect(checked.length).toBe(5);
    for (const r of checked) expect(r.body, r.prelude).toMatch(/border:\s*1px solid var\(--byok-edge\)/);
  });

  it("is imported by the panel component itself, so it loads only where the panel is used", () => {
    expect(componentSource).toContain('import "../../styles/byok-panels.css"');
  });
});
