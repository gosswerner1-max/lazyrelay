import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompetitorPanel } from "./CompetitorPanel";
import { CLOSED_NETWORK_MESSAGE, CONSENT_TEXT, CompetitorError, type CompetitorAnalysis, type CompetitorClient } from "../../lib/competitorMode";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DASH = /[\u2013\u2014]/;

const analysis: CompetitorAnalysis = {
  kind: "page",
  sourceUrl: "https://rival.example/pricing",
  title: "Rival pricing page",
  facts: ["Two plans are listed", "A free trial is offered"],
  draft: { content: "Two plans and a free trial. Here is how that compares.", tags: ["pricing"] },
  creditsUsed: 2,
};

function setup(over: Partial<CompetitorClient> = {}, save: (f: { content: string; tags: string[] }) => Promise<void> = async () => undefined) {
  const analyze = vi.fn(async (_input: string, _signal?: AbortSignal) => analysis);
  const client: CompetitorClient = { analyze, ...over };
  const onSaveDraft = vi.fn(save);
  const view = render(<CompetitorPanel client={client} onSaveDraft={onSaveDraft} />);
  return { analyze: client.analyze as ReturnType<typeof vi.fn>, onSaveDraft, ...view };
}

const box = () => screen.getByLabelText("Paste a competitor link or website") as HTMLInputElement;
const analyzeBtn = () => screen.getByRole("button", { name: "Analyze" });

async function openDialog(link = "https://rival.example/pricing") {
  await userEvent.type(box(), link);
  await userEvent.click(analyzeBtn());
  return screen.findByRole("dialog");
}

async function confirm() {
  const dialog = await openDialog();
  await userEvent.click(within(dialog).getByRole("checkbox"));
  await userEvent.click(within(dialog).getByRole("button", { name: /analyze this link/i }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe("the box and the button", () => {
  it("has one text box, one Analyze button, and says YouTube links work", () => {
    setup();
    expect(box()).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getAllByText(/YouTube/).length).toBeGreaterThan(0);
  });

  it("has no em or en dash, and none of the claims we cannot prove", () => {
    const { container } = setup();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(DASH);
    expect(text).not.toMatch(/\b(safe|guarantee[ds]?|accurate|instant(ly)?)\b/i);
  });

  it("asks for a link when the box is empty, and opens nothing", async () => {
    const { analyze } = setup();
    await userEvent.click(analyzeBtn());
    expect(screen.getByRole("alert")).toHaveTextContent(/paste/i);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(analyze).not.toHaveBeenCalled();
  });

  it("catches a closed network before the dialog, with the exact message, and sends nothing", async () => {
    const { analyze } = setup();
    await userEvent.type(box(), "https://www.tiktok.com/@someone/video/1");
    await userEvent.click(analyzeBtn());
    expect(screen.getByRole("alert")).toHaveTextContent(CLOSED_NETWORK_MESSAGE);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(analyze).not.toHaveBeenCalled();
  });

  it("opens the dialog on Enter in the box as well", async () => {
    setup();
    await userEvent.type(box(), "rival.example{Enter}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

describe("the consent dialog", () => {
  it("is a labelled modal dialog with the exact consent text, and nothing is sent yet", async () => {
    const { analyze } = setup();
    const dialog = await openDialog();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName();
    expect(within(dialog).getByLabelText(CONSENT_TEXT)).toBeInTheDocument();
    expect(CONSENT_TEXT).toBe("AI can make mistakes. I confirm this tool is used for public market analysis and research purposes.");
    expect(analyze).not.toHaveBeenCalled();
  });

  it("keeps the confirm button off until the box is ticked, and off again when it is unticked", async () => {
    const { analyze } = setup();
    const dialog = await openDialog();
    const go = within(dialog).getByRole("button", { name: /analyze this link/i });
    expect(go).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("checkbox"));
    expect(go).toBeEnabled();
    await userEvent.click(within(dialog).getByRole("checkbox"));
    expect(go).toBeDisabled();
    expect(analyze).not.toHaveBeenCalled();
  });

  it("moves focus in, and Cancel sends nothing and hands focus back to Analyze", async () => {
    const { analyze } = setup();
    const dialog = await openDialog();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(analyze).not.toHaveBeenCalled();
    expect(analyzeBtn()).toHaveFocus();
  });

  it("closes on Escape, sends nothing, and hands focus back", async () => {
    const { analyze } = setup();
    await openDialog();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(analyze).not.toHaveBeenCalled();
    expect(analyzeBtn()).toHaveFocus();
  });

  it("closes on a click on the backdrop, and sends nothing", async () => {
    const { analyze } = setup();
    const dialog = await openDialog();
    fireEvent.mouseDown(dialog.parentElement as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(analyze).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the dialog, both ways round", async () => {
    setup();
    const dialog = await openDialog();
    const checkbox = within(dialog).getByRole("checkbox");
    await userEvent.click(checkbox); // now every control is enabled
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const go = within(dialog).getByRole("button", { name: /analyze this link/i });
    go.focus();
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect([checkbox, cancel]).toContain(document.activeElement);
    checkbox.focus();
    await userEvent.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("asks again every time: the tick does not carry over to the next open", async () => {
    setup();
    let dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(analyzeBtn());
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
  });
});

describe("running, the draft, and saving", () => {
  it("sends the checked link with an abort signal only after the tick and the confirm, then shows the draft", async () => {
    const { analyze } = setup();
    await confirm();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0]![0]).toBe("https://rival.example/pricing");
    expect(analyze.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
    expect(await screen.findByText("Rival pricing page")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /rival\.example\/pricing/ });
    expect(link).toHaveAttribute("href", "https://rival.example/pricing");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect((screen.getByLabelText("Draft post") as HTMLTextAreaElement).value).toBe(analysis.draft.content);
    expect(screen.getByText(`${analysis.draft.content.length} / 280`)).toBeInTheDocument();
    expect(screen.getByText("Two plans are listed")).toBeInTheDocument();
  });

  it("shows a progress state while it works, with a way out", async () => {
    let finish: (a: CompetitorAnalysis) => void = () => undefined;
    const { analyze } = setup({ analyze: vi.fn(() => new Promise<CompetitorAnalysis>((r) => (finish = r))) });
    await confirm();
    expect(screen.getByRole("status")).toHaveTextContent(/reading/i);
    expect(analyzeBtn()).toHaveAttribute("aria-disabled", "true");
    expect(analyze).toBeDefined();
    await act(async () => finish(analysis));
    expect(await screen.findByText("Rival pricing page")).toBeInTheDocument();
    expect(screen.queryByText(/reading the page/i)).toBeNull();
  });

  it("keeps keyboard focus on Analyze after the confirm (it is marked busy, not removed), and ignores Enter while it works", async () => {
    const { analyze } = setup({ analyze: vi.fn(() => new Promise<CompetitorAnalysis>(() => undefined)) });
    await confirm();
    expect(analyzeBtn()).toHaveFocus();
    expect(analyzeBtn()).toHaveAttribute("aria-disabled", "true");
    await userEvent.type(box(), "{Enter}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("a press on the card that ends on the backdrop (a text selection drag) does not close the dialog", async () => {
    setup();
    const dialog = await openDialog();
    fireEvent.mouseDown(within(dialog).getByText("Before you analyze"));
    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Cancel while it works stops quietly: no error, the box is back", async () => {
    let signal: AbortSignal | undefined;
    setup({ analyze: vi.fn((_i: string, s?: AbortSignal) => ((signal = s), new Promise<CompetitorAnalysis>(() => undefined))) });
    await confirm();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(analyzeBtn()).not.toHaveAttribute("aria-disabled");
  });

  it("gives up after 90 seconds with a visible friendly error, even if the request never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let signal: AbortSignal | undefined;
    setup({ analyze: vi.fn((_i: string, s?: AbortSignal) => ((signal = s), new Promise<CompetitorAnalysis>(() => undefined))) });
    fireEvent.change(box(), { target: { value: "https://rival.example/pricing" } });
    fireEvent.click(analyzeBtn());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /analyze this link/i }));
    expect(screen.getByRole("status")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(89_000);
    });
    expect(screen.getByRole("status")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(1_500);
    });
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(/too long/i);
    expect(analyzeBtn()).not.toHaveAttribute("aria-disabled");
  });

  it("shows a plain error, never the code or a stack, when the service refuses", async () => {
    setup({ analyze: vi.fn(async () => Promise.reject(new CompetitorError("plan_limit"))) });
    await confirm();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/upgrade your plan/i);
    expect(alert.textContent).not.toMatch(/plan_limit|Error:|at /);
  });

  it("an error that is not ours still shows a plain line and keeps the raw error in the console", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setup({ analyze: vi.fn(async () => Promise.reject(new TypeError("boom internal"))) });
    await confirm();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/boom|TypeError/);
    expect(spy).toHaveBeenCalled();
  });

  it("counts the draft against 280 and blocks saving past it", async () => {
    setup();
    await confirm();
    const area = (await screen.findByLabelText("Draft post")) as HTMLTextAreaElement;
    const save = screen.getByRole("button", { name: "Save as draft" });
    expect(save).toBeEnabled();
    fireEvent.change(area, { target: { value: "x".repeat(281) } });
    expect(screen.getByText("281 / 280")).toBeInTheDocument();
    expect(save).toBeDisabled();
    expect(screen.getByText(/280 characters or fewer/i)).toBeInTheDocument();
    fireEvent.change(area, { target: { value: "" } });
    expect(save).toBeDisabled();
  });

  it("saves the edited text through the app's draft call, tagged, and says it is only a draft", async () => {
    const { onSaveDraft } = setup();
    await confirm();
    const area = (await screen.findByLabelText("Draft post")) as HTMLTextAreaElement;
    await userEvent.clear(area);
    await userEvent.type(area, "My own wording");
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    expect(onSaveDraft).toHaveBeenCalledWith({ content: "My own wording", tags: ["cs:competitor:rival.example"] });
    expect(await screen.findByText(/saved as a draft/i)).toHaveTextContent(/not (scheduled|posted)/i);
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
    expect(screen.getByLabelText("Draft post")).toHaveAttribute("readonly"); // no second copy by accident
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
  });

  it("says so in plain words when saving fails, keeps the text, and lets the customer try again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let fail = true;
    const { onSaveDraft } = setup({}, async () => {
      if (fail) throw new Error("HTTP 500 /scheduled-posts/draft");
    });
    await confirm();
    await userEvent.click(await screen.findByRole("button", { name: "Save as draft" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not save/i);
    expect(alert.textContent).not.toMatch(/HTTP|500|scheduled-posts/);
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/saved as a draft/i)).toBeInTheDocument();
  });

  it("a new analysis clears the old result while it works", async () => {
    const answers: Array<Promise<CompetitorAnalysis>> = [Promise.resolve(analysis), new Promise<CompetitorAnalysis>(() => undefined)];
    setup({ analyze: vi.fn(() => answers.shift()!) });
    await confirm();
    await screen.findByText("Rival pricing page");
    await userEvent.clear(box());
    await userEvent.type(box(), "https://other.example/x");
    await userEvent.click(analyzeBtn());
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: /analyze this link/i }));
    expect(screen.queryByText("Rival pricing page")).toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows a YouTube result as a video", async () => {
    setup({ analyze: vi.fn(async () => ({ ...analysis, kind: "youtube" as const, sourceUrl: "https://www.youtube.com/watch?v=abc" })) });
    await confirm();
    expect(await screen.findByText("YouTube video")).toBeInTheDocument();
  });

  it("never turns a non web source link into a clickable link", async () => {
    setup({ analyze: vi.fn(async () => ({ ...analysis, sourceUrl: "javascript:alert(1)" })) });
    await confirm();
    await screen.findByText("Rival pricing page");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows the whole result without an em or en dash of ours", async () => {
    const { container } = setup();
    await confirm();
    await screen.findByText("Rival pricing page");
    expect(container.textContent).not.toMatch(DASH);
  });
});
