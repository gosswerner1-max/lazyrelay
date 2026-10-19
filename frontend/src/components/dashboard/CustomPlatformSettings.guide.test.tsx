import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

// The X and the WhatsApp developer keys cards each carry their short in-app setup guide (collapsed), right beside the inputs. A locked
// plan shows no guide. The WhatsApp tab keeps its own copy, so these tests look inside one card at a time. The API is a mock.

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
import { WHATSAPP_GUIDE, X_GUIDE } from "../../lib/byokGuides";
import type { PlatformInfo } from "../../lib/api";

const X_OK: PlatformInfo = { platform: "x", configured: true, comingSoon: false, requiresPlan: "Starter", allowed: true };
const X_LOCKED: PlatformInfo = { platform: "x", configured: true, comingSoon: false, requiresPlan: "Starter", allowed: false };
const WA_OK: PlatformInfo = { platform: "whatsapp", configured: true, comingSoon: false, requiresPlan: "Starter", allowed: true };
const WA_LOCKED: PlatformInfo = { ...WA_OK, allowed: false };
const waCard = () => screen.getByRole("region", { name: "WhatsApp developer keys" });
const xCard = () => screen.getByRole("region", { name: "X developer keys" });

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getWhatsAppWebhookInfo.mockResolvedValue({ webhookUrl: "https://api.example.test/api/webhooks/whatsapp", verifyToken: "t", verifyTokenConfigured: true, connections: [], triageEnabled: false });
});

describe("X card setup guide", () => {
  it("shows the collapsed guide with every step above the key fields", () => {
    const { container } = render(<CustomPlatformSettings platforms={[X_OK]} />);
    expect(screen.getByText(X_GUIDE.title)).toBeInTheDocument();
    const details = container.querySelector("details.byok-guide") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    for (const step of X_GUIDE.steps) expect(screen.getByText(step.title)).toBeInTheDocument();
  });

  it("is not shown when the plan is locked", () => {
    render(<CustomPlatformSettings platforms={[X_LOCKED]} />);
    expect(screen.queryByText(X_GUIDE.title)).toBeNull();
  });
});

describe("WhatsApp card setup guide", () => {
  it("shows the collapsed guide with every step between the hint and the form", () => {
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    const card = waCard();
    expect(within(card).getByText(WHATSAPP_GUIDE.title)).toBeInTheDocument();
    const details = card.querySelector("details.byok-guide") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    for (const step of WHATSAPP_GUIDE.steps) expect(within(card).getByText(step.title)).toBeInTheDocument();
    const form = card.querySelector("form") as HTMLFormElement;
    expect(details.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is not shown when the plan is locked", () => {
    render(<CustomPlatformSettings platforms={[WA_LOCKED]} />);
    expect(within(waCard()).queryByText(WHATSAPP_GUIDE.title)).toBeNull();
  });
});

describe("WhatsApp card inputs", () => {
  it("links the App Secret hint to its input with aria-describedby", () => {
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    const input = within(waCard()).getByLabelText("App Secret (optional)");
    const hintId = input.getAttribute("aria-describedby");
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId as string)?.textContent).toContain("The App Secret is on your Meta app");
  });

  it("puts the same length limits on the fields as the backend", () => {
    render(<CustomPlatformSettings platforms={[WA_OK]} />);
    const card = within(waCard());
    for (const label of ["WABA ID", "Phone number ID"]) {
      const el = card.getByLabelText(label);
      expect(el).toHaveAttribute("maxlength", "25");
      expect(el).toHaveAttribute("inputmode", "numeric");
    }
    expect(card.getByLabelText("System user token")).toHaveAttribute("maxlength", "512");
    expect(card.getByLabelText("App Secret (optional)")).toHaveAttribute("maxlength", "64");
  });
});

describe("X card inputs", () => {
  it("limits the four keys to 200 characters", () => {
    render(<CustomPlatformSettings platforms={[X_OK]} />);
    const card = within(xCard());
    for (const label of ["API Key (Consumer Key)", "API Secret (Consumer Secret)", "Access Token", "Access Token Secret"]) {
      expect(card.getByLabelText(label)).toHaveAttribute("maxlength", "200");
    }
  });
});
