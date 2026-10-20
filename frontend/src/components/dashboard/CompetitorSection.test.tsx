import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompetitorError } from "../../lib/competitorMode";

// The section joins the competitor panel to the app's own draft call and the service client the build setting names.
// Both are fakes here: no network is touched.

const api = vi.hoisted(() => ({ saveDraft: vi.fn() }));
vi.mock("../../lib/api", () => ({ api }));

const analyze = vi.hoisted(() => vi.fn());
vi.mock("../../lib/competitorDefault", () => ({ defaultCompetitorClient: { analyze } }));

import CompetitorSection from "./CompetitorSection";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const answer = {
  kind: "page" as const,
  sourceUrl: "https://rival.example/pricing",
  title: "Rival pricing page",
  facts: [],
  draft: { content: "A short draft.", tags: [] },
  creditsUsed: 1,
};

async function analyzeAndSave() {
  await userEvent.type(screen.getByLabelText("Paste a competitor link or website"), "https://rival.example/pricing");
  await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("checkbox"));
  await userEvent.click(within(dialog).getByRole("button", { name: /analyze this link/i }));
  await userEvent.click(await screen.findByRole("button", { name: "Save as draft" }));
}

describe("CompetitorSection", () => {
  it("saves through the app's own draft call as a plain draft (no account, no time), then refreshes the posts", async () => {
    analyze.mockResolvedValue(answer);
    api.saveDraft.mockResolvedValue({ id: "d1" });
    const onSaved = vi.fn();
    render(<CompetitorSection onSaved={onSaved} />);
    await analyzeAndSave();
    await waitFor(() => expect(api.saveDraft).toHaveBeenCalledTimes(1));
    expect(api.saveDraft).toHaveBeenCalledWith({ content: "A short draft.", tags: ["cs:competitor:rival.example"] });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/saved as a draft/i)).toBeInTheDocument();
  });

  it("still says the draft is saved when the refresh of the post list fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    analyze.mockResolvedValue(answer);
    api.saveDraft.mockResolvedValue({ id: "d1" });
    render(<CompetitorSection onSaved={() => Promise.reject(new Error("list failed"))} />);
    await analyzeAndSave();
    expect(await screen.findByText(/saved as a draft/i)).toBeInTheDocument();
  });

  it("shows the plain 'not switched on yet' line when the service is not connected", async () => {
    analyze.mockRejectedValue(new CompetitorError("not_connected"));
    render(<CompetitorSection />);
    await userEvent.type(screen.getByLabelText("Paste a competitor link or website"), "rival.example");
    await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: /analyze this link/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This feature is not switched on yet.");
  });
});
