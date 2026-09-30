import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({ completeManualConnect: vi.fn(async () => ({})) }));
vi.mock("../lib/api", () => ({ api }));

import { ConnectForm } from "./ConnectForm";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function fillAndSubmit(server?: string) {
  render(<ConnectForm platform="bluesky" state="st1" />);
  await userEvent.type(screen.getByLabelText(/^Handle/), "alice.example.com");
  await userEvent.type(screen.getByLabelText(/^App password/), "xxxx-xxxx-xxxx-xxxx");
  if (server !== undefined) await userEvent.type(screen.getByLabelText(/^Server/), server);
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
}

describe("Bluesky connect form", () => {
  it("shows the optional server field with its plain-language label", () => {
    render(<ConnectForm platform="bluesky" state="st1" />);
    const field = screen.getByLabelText("Server (only if your account is not hosted on bsky.social)");
    expect(field).not.toBeRequired();
  });

  it("leaving the server empty sends exactly what it always sent", async () => {
    await fillAndSubmit();
    expect(api.completeManualConnect).toHaveBeenCalledTimes(1);
    const [code, state] = api.completeManualConnect.mock.calls[0] as unknown as [string, string];
    expect(JSON.parse(code)).toEqual({ identifier: "alice.example.com", password: "xxxx-xxxx-xxxx-xxxx" });
    expect(state).toBe("st1");
  });

  it("a typed server goes in the JSON code as server, trimmed", async () => {
    await fillAndSubmit(" pds.example.com ");
    const [code] = api.completeManualConnect.mock.calls[0] as unknown as [string, string];
    expect(JSON.parse(code)).toEqual({ identifier: "alice.example.com", password: "xxxx-xxxx-xxxx-xxxx", server: "pds.example.com" });
  });
});
