import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The X developer keys card now carries the short in-app setup guide (collapsed). The WhatsApp card does not repeat it: its guide lives
// in the WhatsApp tab. A locked plan shows no guide. The API is a mock.

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
import { X_GUIDE } from "../../lib/byokGuides";
import type { PlatformInfo } from "../../lib/api";

const X_OK: PlatformInfo = { platform: "x", configured: true, comingSoon: false, requiresPlan: "Starter", allowed: true };
const X_LOCKED: PlatformInfo = { platform: "x", configured: true, comingSoon: false, requiresPlan: "Starter", allowed: false };

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
