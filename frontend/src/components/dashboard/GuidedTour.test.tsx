import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GuidedTour } from "./GuidedTour";
import type { TourStep } from "../../lib/guidedTour";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const STEPS: TourStep[] = [
  { id: "one", selector: '[data-tour="one"]', title: "Step 1: First", text: "First text." },
  { id: "gone", selector: '[data-tour="gone"]', title: "Step X: Missing", text: "Never shown." },
  { id: "two", selector: '[data-tour="two"]', title: "Step 2: Second", text: "Second text." },
  { id: "three", selector: '[data-tour="three"]', title: "Step 3: Third", text: "Third text." },
];

function Host({ steps = STEPS, withThree = true }: { steps?: TourStep[]; withThree?: boolean }) {
  return (
    <div className="byok-panels">
      <input data-tour="one" aria-label="first target" />
      <button data-tour="two">second target</button>
      {withThree && <span data-tour="three">third target</span>}
      <GuidedTour steps={steps} />
    </div>
  );
}

const trigger = () => screen.getByRole("button", { name: "Help me set up" });
const open = async () => userEvent.click(trigger());

describe("the trigger", () => {
  it("is a button with a small SVG bulb icon that screen readers skip, and no emoji", () => {
    const { container } = render(<Host />);
    const svg = trigger().querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(trigger()).toHaveAttribute("type", "button");
  });
  it("starts closed", () => {
    render(<Host />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("opening and the steps", () => {
  it("opens a non-modal dialog named by its title and described by its text, and moves focus into it", async () => {
    render(<Host />);
    await open();
    const dialog = screen.getByRole("dialog", { name: "Step 1: First" });
    expect(dialog).toHaveAccessibleDescription("First text.");
    expect(dialog).not.toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveFocus();
  });
  it("counts only the steps whose target is on the page, in order", async () => {
    render(<Host />);
    await open();
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("dialog", { name: "Step 2: Second" })).toBeInTheDocument();
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    expect(screen.queryByText("Never shown.")).toBeNull();
  });
  it("adapts when a target is absent", async () => {
    render(<Host withThree={false} />);
    await open();
    expect(screen.getByText("Step 1 of 2")).toBeInTheDocument();
  });
  it("does not open when no step has a target", async () => {
    render(<Host steps={[STEPS[1]!]} />);
    await open();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("goes Back and Next, disables Back on the first step, and offers Done on the last", async () => {
    render(<Host />);
    await open();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("dialog", { name: "Step 3: Third" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("dialog", { name: "Step 2: Second" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("dialog", { name: "Step 1: First" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
  });
  it("draws a highlight ring and scrolls the target into view", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { container } = render(<Host />);
    await open();
    expect(document.querySelector(".guided-tour__ring")).not.toBeNull();
    expect(scroll).toHaveBeenCalled();
    expect(container.querySelector(".guided-tour__ring")).not.toBeNull();
  });
});

describe("closing", () => {
  it("Done closes and gives focus back to the trigger", async () => {
    render(<Host />);
    await open();
    for (let i = 0; i < 2; i++) await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".guided-tour__ring")).toBeNull();
    expect(trigger()).toHaveFocus();
  });
  it("Escape closes and gives focus back to the trigger", async () => {
    render(<Host />);
    await open();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger()).toHaveFocus();
  });
  it("starts again from step 1 when reopened", async () => {
    render(<Host />);
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.keyboard("{Escape}");
    await open();
    expect(screen.getByRole("dialog", { name: "Step 1: First" })).toBeInTheDocument();
  });
  it("stores nothing", async () => {
    const before = localStorage.length + sessionStorage.length;
    render(<Host />);
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.keyboard("{Escape}");
    expect(localStorage.length + sessionStorage.length).toBe(before);
  });
});
