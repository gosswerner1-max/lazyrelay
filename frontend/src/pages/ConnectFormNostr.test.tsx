import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({ completeManualConnect: vi.fn(async () => ({})) }));
vi.mock("../lib/api", () => ({ api }));

import { ConnectForm } from "./ConnectForm";
import { NOSTR_SECRET_MESSAGE } from "../lib/nostrSecrets";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Throwaway values built from characters, not real keys.
const NSEC = `nsec1${"qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(2).slice(0, 58)}`;
const HEX = "ab".repeat(32);
const LINK = `bunker://${"c".repeat(64)}?relay=wss%3A%2F%2Frelay.example.org&secret=abc123`;
const field = () => screen.getByLabelText("Bunker link from your signer app") as HTMLInputElement;
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

describe("Nostr connect form", () => {
  it("explains in plain words that the private key never reaches LazyRelay, and how to get a link", () => {
    const { container } = render(<ConnectForm platform="nostr" state="st1" />);
    expect(screen.getByText("LazyRelay never sees your private key.")).toBeInTheDocument();
    expect(container.textContent).toMatch(/signer app has to be online/);
    expect(container.textContent).toMatch(/plain text only/);
    expect(container.textContent).not.toMatch(DASHES);
    expect(field()).toBeRequired();
    expect(field()).toHaveAttribute("type", "password");
  });

  it("sends a bunker link as JSON, trimmed, over the POST callback with the state", async () => {
    render(<ConnectForm platform="nostr" state="st1" />);
    await userEvent.type(field(), `  ${LINK} `);
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(api.completeManualConnect).toHaveBeenCalledTimes(1);
    const [code, state] = api.completeManualConnect.mock.calls[0] as unknown as [string, string];
    expect(JSON.parse(code)).toEqual({ bunkerUrl: LINK });
    expect(state).toBe("st1");
  });

  it("refuses an nsec the moment it is pasted: message shown, field wiped, nothing sent", async () => {
    render(<ConnectForm platform="nostr" state="st1" />);
    await userEvent.click(field());
    await userEvent.paste(NSEC);
    expect(screen.getByText(NOSTR_SECRET_MESSAGE)).toBeInTheDocument();
    expect(field()).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(api.completeManualConnect).not.toHaveBeenCalled();
  });

  it("refuses a 64 character hex secret and a recovery phrase the same way", async () => {
    render(<ConnectForm platform="nostr" state="st1" />);
    for (const secret of [HEX, "abandon ability able about above absent absorb abstract absurd abuse access accident"]) {
      await userEvent.click(field());
      await userEvent.paste(secret);
      expect(screen.getByText(NOSTR_SECRET_MESSAGE)).toBeInTheDocument();
      expect(field()).toHaveValue("");
    }
    expect(api.completeManualConnect).not.toHaveBeenCalled();
  });

  it("shows the server's plain message when the connect fails, and keeps nothing secret on screen", async () => {
    api.completeManualConnect.mockRejectedValueOnce(new Error("Your signer did not answer in time."));
    render(<ConnectForm platform="nostr" state="st1" />);
    await userEvent.type(field(), LINK);
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Your signer did not answer in time.")).toBeInTheDocument();
  });
});
