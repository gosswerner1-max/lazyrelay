import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompetitorPanel } from "./CompetitorPanel";
import { CLOSED_NETWORK_MESSAGE, CONSENT_TEXT, CompetitorError, VIDEO_NOT_SUPPORTED_MESSAGE, type CompetitorClient } from "../../lib/competitorMode";
import { BASED_ON_TEXT, type CompetitorBlueprint } from "../../lib/competitorBlueprint";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DASH = /[\u2013\u2014]/;

const answer: CompetitorBlueprint = {
  kind: "page",
  sourceUrl: "https://rival.example/pricing",
  title: "Rival pricing page",
  blueprint: {
    hook: { type: "statistic", note: "It opens with a number about wasted hours." },
    sections: [
      { order: 1, role: "Problem", summary: "Names the pain." },
      { order: 2, role: "Plans", summary: "Lists two plans." },
    ],
    cta: { placement: "bottom", style: "One button", count: 1 },
    adjustments: ["Open with a number too.", "Put your plans higher."],
  },
  creditsUsed: 2,
};

function setup(over: Partial<CompetitorClient> = {}) {
  const analyze = vi.fn(async (_input: string, _signal?: AbortSignal) => answer);
  const client: CompetitorClient = { blueprint: analyze, ...over };
  const view = render(<CompetitorPanel client={client} />);
  return { analyze: client.blueprint as ReturnType<typeof vi.fn>, ...view };
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
  it("has one text box, one Analyze button, and says it is for web pages and posts, not video or closed networks", () => {
    const { container } = setup();
    expect(box()).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(container.textContent).toMatch(/web ?(page|site)/i);
    expect(container.textContent).toMatch(/video links do not/i);
    expect(screen.getByRole("heading", { name: "Competitor content blueprint" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/draft|YouTube/i);
  });

  it("has no em or en dash, and none of the claims we cannot prove", () => {
    const { container } = setup();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(DASH);
    expect(text).not.toMatch(/\b(safe|guarantee[ds]?|accurate|instant(ly)?|successful|proven)\b/i);
  });

  it.each(["https://www.youtube.com/watch?v=abc123", "https://youtu.be/abc123"])("catches the video link %s before the dialog, with the exact words, and sends nothing", async (link) => {
    const { analyze } = setup();
    await userEvent.type(box(), link);
    await userEvent.click(analyzeBtn());
    expect(screen.getByRole("alert")).toHaveTextContent(VIDEO_NOT_SUPPORTED_MESSAGE);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(analyze).not.toHaveBeenCalled();
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

  it("pins the checkbox and both buttons in a footer outside the scrolling text, so a short window never hides them", async () => {
    setup();
    const dialog = await openDialog();
    const body = dialog.querySelector(".cs-modal__body") as HTMLElement;
    const footer = dialog.querySelector(".cs-modal__footer") as HTMLElement;
    expect(body).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(body.contains(footer)).toBe(false);
    expect(footer.contains(body)).toBe(false);
    expect(footer.parentElement).toBe(dialog);
    expect(body.parentElement).toBe(dialog);
    expect(body.nextElementSibling).toBe(footer);
    expect(within(body).getByRole("heading", { name: "Before you analyze" })).toBeInTheDocument();
    expect(within(body).getByText("https://rival.example/pricing")).toBeInTheDocument();
    expect(within(body).queryByRole("checkbox")).toBeNull();
    expect(within(body).queryByRole("button")).toBeNull();
    expect(within(footer).getByLabelText(CONSENT_TEXT)).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: /analyze this link/i })).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(body).toHaveAttribute("tabindex", "0"); // the only scrolling part can be scrolled from the keyboard
  });

  it("keeps Tab inside the dialog, with the footer controls last", async () => {
    setup();
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("checkbox"));
    within(dialog).getByRole("button", { name: "Cancel" }).focus();
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(within(dialog).getByRole("button", { name: "Cancel" }));
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

describe("running and the blueprint", () => {
  it("sends the checked link with an abort signal only after the tick and the confirm, then shows the blueprint", async () => {
    const { analyze } = setup();
    await confirm();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0]![0]).toBe("https://rival.example/pricing");
    expect(analyze.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
    expect(await screen.findByText("Rival pricing page")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /rival\.example\/pricing/ });
    expect(link).toHaveAttribute("href", "https://rival.example/pricing");
    expect(screen.getByRole("heading", { name: "Competitor structure" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recommended adjustments" })).toBeInTheDocument();
    expect(screen.getByText("Opens with a statistic")).toBeInTheDocument();
    expect(screen.getByText("Open with a number too.")).toBeInTheDocument();
    expect(screen.getByText(BASED_ON_TEXT)).toBeInTheDocument();
  });

  it("shows no draft, no saving and no editing: the old draft view is gone", async () => {
    setup();
    await confirm();
    await screen.findByText("Rival pricing page");
    expect(screen.queryByText(/save as draft/i)).toBeNull();
    expect(screen.queryByText(/draft/i)).toBeNull();
    expect(screen.queryByRole("textbox", { name: /draft/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy blueprint" })).toBeInTheDocument();
  });

  it("shows a progress state while it works, with a way out", async () => {
    let finish: (a: CompetitorBlueprint) => void = () => undefined;
    setup({ blueprint: vi.fn(() => new Promise<CompetitorBlueprint>((r) => (finish = r))) });
    await confirm();
    expect(screen.getByRole("status")).toHaveTextContent(/reading the page and building your blueprint/i);
    expect(analyzeBtn()).toHaveAttribute("aria-disabled", "true");
    await act(async () => finish(answer));
    expect(await screen.findByText("Rival pricing page")).toBeInTheDocument();
    expect(screen.queryByText(/reading the page/i)).toBeNull();
  });

  it("keeps keyboard focus on Analyze after the confirm (it is marked busy, not removed), and ignores Enter while it works", async () => {
    const { analyze } = setup({ blueprint: vi.fn(() => new Promise<CompetitorBlueprint>(() => undefined)) });
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

  it("the dialog speaks of a blueprint, not a draft, and keeps the exact consent sentence", async () => {
    setup();
    const dialog = await openDialog();
    expect(dialog.textContent).not.toMatch(/draft/i);
    expect(dialog.textContent).toMatch(/blueprint/i);
    expect(within(dialog).getByText(CONSENT_TEXT)).toBeInTheDocument();
  });

  it("Cancel while it works stops quietly: no error, the box is back", async () => {
    let signal: AbortSignal | undefined;
    setup({ blueprint: vi.fn((_i: string, s?: AbortSignal) => ((signal = s), new Promise<CompetitorBlueprint>(() => undefined))) });
    await confirm();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(analyzeBtn()).not.toHaveAttribute("aria-disabled");
  });

  it("gives up after 90 seconds with a visible friendly error, even if the request never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let signal: AbortSignal | undefined;
    setup({ blueprint: vi.fn((_i: string, s?: AbortSignal) => ((signal = s), new Promise<CompetitorBlueprint>(() => undefined))) });
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

  it.each([
    ["plan_limit", /upgrade your plan/i],
    ["blueprint_not_supported", /^Blueprints work on web pages and posts for now\. Paste a page from their website\.$/],
    ["blueprint_failed", /^We could not build a blueprint for that page, try another page$/],
  ] as const)("shows a plain error for %s, never the code or a stack", async (code, pattern) => {
    setup({ blueprint: vi.fn(async () => Promise.reject(new CompetitorError(code))) });
    await confirm();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(pattern);
    expect(alert.textContent).not.toMatch(/plan_limit|blueprint_|Error:|\bat \w+\.tsx?/);
  });

  it("an error that is not ours still shows a plain line and keeps the raw error in the console", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setup({ blueprint: vi.fn(async () => Promise.reject(new TypeError("boom internal"))) });
    await confirm();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/boom|TypeError/);
    expect(spy).toHaveBeenCalled();
  });

  it("a new analysis clears the old result while it works", async () => {
    const answers: Array<Promise<CompetitorBlueprint>> = [Promise.resolve(answer), new Promise<CompetitorBlueprint>(() => undefined)];
    setup({ blueprint: vi.fn(() => answers.shift()!) });
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

  it("copies the blueprint from the result", async () => {
    const writeText = vi.fn(async (_t: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setup();
    await confirm();
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Copy blueprint" })));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toContain("Recommended adjustments");
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("shows the whole result without an em or en dash of ours", async () => {
    const { container } = setup();
    await confirm();
    await screen.findByText("Rival pricing page");
    expect(container.textContent).not.toMatch(DASH);
  });
});
