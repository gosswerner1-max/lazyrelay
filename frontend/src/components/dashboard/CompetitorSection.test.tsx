import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompetitorError } from "../../lib/competitorMode";

// The section joins the competitor panel to the service client the build setting names. The client is a fake here:
// no network is touched. The section no longer has any way to save, schedule or post anything.

const blueprint = vi.hoisted(() => vi.fn());
vi.mock("../../lib/competitorDefault", () => ({ defaultCompetitorClient: { blueprint } }));

import CompetitorSection from "./CompetitorSection";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const answer = {
  kind: "page" as const,
  sourceUrl: "https://rival.example/pricing",
  title: "Rival pricing page",
  blueprint: {
    hook: { type: "question" as const, note: "It asks a question." },
    sections: [{ order: 1, role: "Problem", summary: "Names the pain." }],
    cta: { placement: "top" as const, style: "A banner", count: 1 },
    adjustments: ["Open with a question too."],
  },
  creditsUsed: 1,
};

async function analyze(link: string) {
  await userEvent.type(screen.getByLabelText("Paste a competitor link or website"), link);
  await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("checkbox"));
  await userEvent.click(within(dialog).getByRole("button", { name: /analyze this link/i }));
}

describe("CompetitorSection", () => {
  it("asks the service for a blueprint and shows it, with nothing to save", async () => {
    blueprint.mockResolvedValue(answer);
    render(<CompetitorSection />);
    await analyze("https://rival.example/pricing");
    expect(await screen.findByRole("heading", { name: "Competitor structure" })).toBeInTheDocument();
    expect(blueprint).toHaveBeenCalledWith("https://rival.example/pricing", expect.any(AbortSignal));
    expect(screen.queryByText(/save as draft/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Copy blueprint" })).toBeInTheDocument();
  });

  it("shows the plain 'not switched on yet' line when the service is not connected", async () => {
    blueprint.mockRejectedValue(new CompetitorError("not_connected"));
    render(<CompetitorSection />);
    await analyze("rival.example");
    expect(await screen.findByRole("alert")).toHaveTextContent("This feature is not switched on yet.");
  });
});
