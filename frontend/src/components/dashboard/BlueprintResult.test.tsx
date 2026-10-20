import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BlueprintResult } from "./BlueprintResult";
import { BASED_ON_TEXT, HOOK_LABELS, CTA_PLACEMENT_LABELS, blueprintToText, readBlueprint, type CompetitorBlueprint } from "../../lib/competitorBlueprint";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
});

const DASH = /[\u2013\u2014]/;

const base = {
  kind: "page",
  sourceUrl: "https://rival.example/guide?x=1",
  title: "Rival guide",
  creditsUsed: 1,
  blueprint: {
    hook: { type: "question", note: "It asks if you are tired of slow posting." },
    sections: [
      { order: 1, role: "Problem", summary: "Explains how slow posting wastes time." },
      { order: 2, role: "Proof", summary: "Shows three customer quotes." },
    ],
    cta: { placement: "bottom", style: "A single button", count: 1 },
    adjustments: ["Open with a question too.", "Move your proof higher."],
  },
};

const make = (blueprint: object = base.blueprint): CompetitorBlueprint => readBlueprint({ ...base, blueprint })!;

function stubClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

describe("the two columns", () => {
  it("has the two headings, the hook in plain words with its note, the numbered sections and the call to action", () => {
    render(<BlueprintResult result={make()} />);
    expect(screen.getByRole("heading", { name: "Competitor structure" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recommended adjustments" })).toBeInTheDocument();
    expect(screen.getByText("Opens with a question")).toBeInTheDocument();
    expect(screen.getByText("It asks if you are tired of slow posting.")).toBeInTheDocument();
    const steps = screen.getAllByRole("listitem").filter((li) => li.closest("ol"));
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent("1.Problem");
    expect(steps[0]).toHaveTextContent("Explains how slow posting wastes time.");
    expect(steps[1]).toHaveTextContent("2.Proof");
    expect(screen.getByText("At the bottom. A single button. Asked 1 time.")).toBeInTheDocument();
    const adjustments = screen.getAllByRole("listitem").filter((li) => li.closest("ul"));
    expect(adjustments.map((li) => li.textContent)).toEqual(["Open with a question too.", "Move your proof higher."]);
  });

  it("puts the competitor column first, then the adjustments, in a grid that can stack", () => {
    const { container } = render(<BlueprintResult result={make()} />);
    const grid = container.querySelector(".cs-bp__grid")!;
    expect(grid.children).toHaveLength(2);
    expect(within(grid.children[0] as HTMLElement).getByRole("heading")).toHaveTextContent("Competitor structure");
    expect(within(grid.children[1] as HTMLElement).getByRole("heading")).toHaveTextContent("Recommended adjustments");
  });

  it.each(Object.entries(HOOK_LABELS))("shows the %s hook as: %s", (type, label) => {
    render(<BlueprintResult result={make({ ...base.blueprint, hook: { type, note: "n" } })} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/bold_claim|how_to|problem_agitate|social_proof/);
  });

  it.each(Object.entries(CTA_PLACEMENT_LABELS))("shows the %s call to action place as: %s", (placement, label) => {
    render(<BlueprintResult result={make({ ...base.blueprint, cta: { placement, style: "", count: 0 } })} />);
    expect(document.body.textContent).toContain(label);
  });

  it("says plainly when nothing was found, and does not crash on an empty blueprint", () => {
    render(<BlueprintResult result={make({})} />);
    expect(screen.getByText("No clear sections were found.")).toBeInTheDocument();
    expect(screen.getByText("No changes to suggest for this page.")).toBeInTheDocument();
    expect(screen.getByText("No clear call to action.")).toBeInTheDocument();
    expect(screen.getByText("Opens in its own way")).toBeInTheDocument();
  });

  it("keeps very long words and long text on the screen (they wrap, they do not widen it)", () => {
    const long = "w".repeat(400);
    const { container } = render(<BlueprintResult result={make({ ...base.blueprint, adjustments: [long], sections: [{ order: 1, role: long, summary: long }] })} />);
    expect(container.textContent).toContain(long);
    expect(container.querySelector(".cs-bp")).toBeInTheDocument();
  });

  it("links the page only when it is a plain web link, and never as a clickable javascript link", () => {
    const { unmount } = render(<BlueprintResult result={make()} />);
    const link = screen.getByRole("link", { name: /rival\.example\/guide/ });
    expect(link).toHaveAttribute("href", "https://rival.example/guide?x=1");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    unmount();
    render(<BlueprintResult result={{ ...make(), sourceUrl: "javascript:alert(1)" }} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("the words", () => {
  it("shows the honest line, the credits, and no draft, save, success or proof talk", () => {
    const { container } = render(<BlueprintResult result={make()} />);
    const text = container.textContent ?? "";
    expect(text).toContain(BASED_ON_TEXT);
    expect(text).toContain("1 credit used.");
    expect(screen.queryByText(/save as draft/i)).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(text).not.toMatch(DASH);
    expect(text).not.toMatch(/\b(safe|guarantee[ds]?|accurate|instant(ly)?|successful|proven|draft|video|motion|pacing)\b/i);
  });

  it("says credits in the plural when there are several", () => {
    render(<BlueprintResult result={{ ...make(), creditsUsed: 3 }} />);
    expect(screen.getByText("3 credits used.")).toBeInTheDocument();
  });
});

describe("Copy blueprint", () => {
  it("copies the plain text of both columns and says it did", async () => {
    const writeText = vi.fn(async (_t: string) => undefined);
    stubClipboard(writeText);
    const result = make();
    render(<BlueprintResult result={result} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy blueprint" })));
    expect(writeText).toHaveBeenCalledWith(blueprintToText(result));
    expect(screen.getByRole("status")).toHaveTextContent("Copied.");
  });

  it("when copying is not allowed, says so plainly, keeps the raw error in the console, and shows the text to copy by hand", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubClipboard(async () => {
      throw new DOMException("denied by policy xyz", "NotAllowedError");
    });
    const result = make();
    render(<BlueprintResult result={result} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy blueprint" })));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/could not copy/i);
    expect(alert.textContent).not.toMatch(/denied|policy|xyz|NotAllowed/);
    expect(spy).toHaveBeenCalled();
    const box = screen.getByLabelText("Blueprint text to copy") as HTMLTextAreaElement;
    expect(box).toHaveAttribute("readonly");
    expect(box.value).toBe(blueprintToText(result));
  });

  it("falls back the same way when the browser has no clipboard at all", async () => {
    render(<BlueprintResult result={make()} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy blueprint" })));
    expect(screen.getByRole("alert")).toHaveTextContent(/could not copy/i);
    expect(screen.getByLabelText("Blueprint text to copy")).toBeInTheDocument();
  });

  it("the copied text holds no token, key or address of the service", async () => {
    const writeText = vi.fn(async (_t: string) => undefined);
    stubClipboard(writeText);
    render(<BlueprintResult result={make()} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy blueprint" })));
    expect(writeText.mock.calls[0]![0]).not.toMatch(/bearer|token|apikey|secret|service\.example/i);
  });
});
