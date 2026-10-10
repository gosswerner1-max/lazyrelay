import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({ checkXKeys: vi.fn(), connectXKeys: vi.fn() }));
vi.mock("../lib/api", () => ({ api }));

import { ConnectX } from "./ConnectX";
import { X_BYOK_CONSENT_TEXT } from "../lib/xByok";

// The exact words Werner approved, typed out again here on purpose: if the shared constant is ever edited, this fails.
const APPROVED =
  "I understand that by using my own custom keys, all publishing and media upload charges are billed directly to my personal X developer wallet according to X's pay-per-use consumption rates. I accept full responsibility for managing my own credit balance and agree to X's Developer terms.";

const FAKE = { apiKey: "fakeApiKey12345", apiSecret: "fakeApiSecret12345", accessToken: "99-fakeAccessToken123", accessTokenSecret: "fakeTokenSecret12345" };

afterEach(cleanup);
beforeEach(() => {
  api.checkXKeys.mockReset();
  api.connectXKeys.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^API Key/), FAKE.apiKey);
  await user.type(screen.getByLabelText(/^API Secret/), FAKE.apiSecret);
  await user.type(screen.getByLabelText(/^Access Token$/), FAKE.accessToken);
  await user.type(screen.getByLabelText(/^Access Token Secret/), FAKE.accessTokenSecret);
}
const secretInputs = () => [screen.getByLabelText(/^API Secret/) as HTMLInputElement, screen.getByLabelText(/^Access Token Secret/) as HTMLInputElement];

describe("the consent text", () => {
  it("the shared constant is exactly the approved wording", () => {
    expect(X_BYOK_CONSENT_TEXT).toBe(APPROVED);
    expect(X_BYOK_CONSENT_TEXT).not.toMatch(/[‘’—–]/); // straight apostrophes, no dashes
  });
  it("appears byte for byte in the rendered page source", () => {
    const { container } = render(<ConnectX />);
    expect(container.innerHTML).toContain(APPROVED);
    expect(container.textContent).toContain(APPROVED);
  });
});

describe("the form", () => {
  it("shows four inputs, secrets hidden, nothing autofilled, and the cost note and guide link", () => {
    render(<ConnectX />);
    const [apiSecret, tokenSecret] = secretInputs();
    expect(apiSecret.type).toBe("password");
    expect(tokenSecret.type).toBe("password");
    expect((screen.getByLabelText(/^API Key/) as HTMLInputElement).type).toBe("text");
    expect((screen.getByLabelText(/^Access Token$/) as HTMLInputElement).type).toBe("text");
    for (const el of [...secretInputs(), screen.getByLabelText(/^API Key/), screen.getByLabelText(/^Access Token$/)]) expect(el.getAttribute("autocomplete")).toBe("off");
    expect(screen.getByText(/\$0\.015/)).toBeTruthy();
    expect(screen.getByText(/\$0\.20/)).toBeTruthy();
    const guide = screen.getByRole("link", { name: /setup guide/i }) as HTMLAnchorElement;
    expect(guide.getAttribute("href")).toBe("/guides/x-developer-keys/");
    expect(guide.getAttribute("target")).toBe("_blank");
    expect(guide.getAttribute("rel")).toContain("noopener");
  });

  it("a secret can be shown and hidden again", async () => {
    const user = userEvent.setup();
    render(<ConnectX />);
    await user.click(screen.getByRole("button", { name: "Show API Secret" }));
    expect(secretInputs()[0].type).toBe("text");
    await user.click(screen.getByRole("button", { name: "Hide API Secret" }));
    expect(secretInputs()[0].type).toBe("password");
  });

  it("Save and connect is impossible until all four are filled AND the box is ticked", async () => {
    const user = userEvent.setup();
    render(<ConnectX />);
    const save = screen.getByRole("button", { name: "Save and connect" }) as HTMLButtonElement;
    const check = screen.getByRole("button", { name: "Check my keys" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(check.disabled).toBe(true);
    await fill(user);
    expect(check.disabled).toBe(false);
    expect(save.disabled).toBe(true); // keys filled, box not ticked
    await user.click(screen.getByRole("checkbox"));
    expect(save.disabled).toBe(false);
    await user.click(screen.getByRole("checkbox"));
    expect(save.disabled).toBe(true);
    expect(api.connectXKeys).not.toHaveBeenCalled();
  });

  it("submitting without the box ticked (Enter in a field) sends nothing", async () => {
    const user = userEvent.setup();
    render(<ConnectX />);
    await fill(user);
    await user.type(screen.getByLabelText(/^Access Token Secret/), "{Enter}");
    expect(api.connectXKeys).not.toHaveBeenCalled();
  });

  it("Save sends the four values, clears the secrets at once, and shows who it connected", async () => {
    const user = userEvent.setup();
    let release: (v: unknown) => void = () => {};
    api.connectXKeys.mockReturnValue(new Promise((r) => (release = r)));
    render(<ConnectX />);
    await fill(user);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    expect(api.connectXKeys).toHaveBeenCalledWith(FAKE);
    // while the request is still in flight the secrets are already gone from the form
    const [apiSecret, tokenSecret] = secretInputs();
    expect(apiSecret.value).toBe("");
    expect(tokenSecret.value).toBe("");
    release({ ok: true, handle: "acme", keyHint: "****2345" });
    await waitFor(() => expect(screen.getByText(/Connected as @acme/)).toBeTruthy());
  });

  it("an error clears both secrets, shows the message, and leaves nothing in storage or the address", async () => {
    const user = userEvent.setup();
    api.connectXKeys.mockRejectedValue(new Error("X did not accept these keys. Check you copied the API Key/Secret and the Access Token/Secret."));
    render(<ConnectX />);
    await fill(user);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/did not accept these keys/));
    const [apiSecret, tokenSecret] = secretInputs();
    expect(apiSecret.value).toBe("");
    expect(tokenSecret.value).toBe("");
    expect((screen.getByLabelText(/^API Key/) as HTMLInputElement).value).toBe(FAKE.apiKey); // the two public-ish values stay for a retry
    const everything = JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage }) + window.location.href + document.cookie;
    for (const v of Object.values(FAKE)) expect(everything.includes(v)).toBe(false);
  });

  it("Check my keys proves them without needing the box, shows the handle, and keeps the form so Save can follow", async () => {
    const user = userEvent.setup();
    api.checkXKeys.mockResolvedValue({ ok: true, handle: "acme", keyHint: "****2345" });
    render(<ConnectX />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Check my keys" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Keys accepted. Connected as @acme/));
    expect(api.checkXKeys).toHaveBeenCalledWith(FAKE);
    expect(api.connectXKeys).not.toHaveBeenCalled();
    expect(secretInputs()[0].value).toBe(FAKE.apiSecret);
  });

  it("a failed check clears the secrets too", async () => {
    const user = userEvent.setup();
    api.checkXKeys.mockRejectedValue(new Error("X did not accept these keys."));
    render(<ConnectX />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Check my keys" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(secretInputs().map((i) => i.value)).toEqual(["", ""]);
  });

  it("a plan refusal from the server is shown as the server worded it", async () => {
    const user = userEvent.setup();
    api.checkXKeys.mockRejectedValue(new Error("Connecting X with your own developer keys is available on the Pro plan and above."));
    render(<ConnectX />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Check my keys" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Pro plan and above/));
  });
});
