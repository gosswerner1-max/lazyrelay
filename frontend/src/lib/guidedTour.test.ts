import { afterEach, describe, expect, it } from "vitest";
import { resolveTourSteps, type TourStep } from "./guidedTour";
import { frontDoorTourSteps } from "./frontDoorTour";

afterEach(() => {
  document.body.innerHTML = "";
});

const el = (html: string) => {
  document.body.innerHTML = html;
};

const step = (id: string, over: Partial<TourStep> = {}): TourStep => ({ id, selector: `[data-tour="${id}"]`, title: id, text: id, ...over });

describe("resolveTourSteps", () => {
  it("keeps the order of the steps and attaches the target element", () => {
    el('<i data-tour="b"></i><i data-tour="a"></i>');
    const out = resolveTourSteps([step("a"), step("b")]);
    expect(out.map((s) => s.id)).toEqual(["a", "b"]);
    expect(out[0]!.element).toBe(document.querySelector('[data-tour="a"]'));
  });
  it("skips a step whose target is missing from the page", () => {
    el('<i data-tour="a"></i><i data-tour="c"></i>');
    expect(resolveTourSteps([step("a"), step("b"), step("c")]).map((s) => s.id)).toEqual(["a", "c"]);
  });
  it("skips a step when onlyIf says no, and keeps it when onlyIf says yes", () => {
    el('<i data-tour="a"></i><i data-tour="b"></i>');
    const out = resolveTourSteps([step("a", { onlyIf: () => false }), step("b", { onlyIf: () => true })]);
    expect(out.map((s) => s.id)).toEqual(["b"]);
  });
  it("takes a ref target, and skips an empty ref", () => {
    el('<i id="x"></i>');
    const full = { current: document.getElementById("x") };
    const empty = { current: null };
    const out = resolveTourSteps([{ id: "r", ref: full, title: "r", text: "r" }, { id: "e", ref: empty, title: "e", text: "e" }]);
    expect(out.map((s) => s.id)).toEqual(["r"]);
  });
  it("skips a step with neither selector nor ref", () => {
    expect(resolveTourSteps([{ id: "n", title: "n", text: "n" }])).toEqual([]);
  });
});

describe("the front door tour", () => {
  const page = (withBalance: boolean) =>
    el(`<input data-tour="competitor-link"><button data-tour="competitor-analyze">Analyze</button>${withBalance ? '<span data-tour="balance"></span>' : ""}`);

  it("has step 1 and step 2 with the exact owner copy", () => {
    page(false);
    const [one, two] = resolveTourSteps(frontDoorTourSteps(30));
    expect(one!.title).toBe("Step 1: Target a Competitor");
    expect(one!.text).toBe("Paste a link to any public website page here. We will show you how it is built: its opening hook, the order of its sections and where its calls to action sit.");
    expect(two!.title).toBe("Step 2: Safety Check");
    expect(two!.text).toBe("When you click Analyze, we ask you to confirm this run is for public market research. No website verification and no password is needed.");
  });

  it("drops step 3 when the balance widget is not on the page, even with a balance", () => {
    page(false);
    expect(resolveTourSteps(frontDoorTourSteps(30)).map((s) => s.id)).toEqual(["link", "analyze"]);
  });

  it("drops step 3 when there is a widget but no balance was passed in", () => {
    page(true);
    expect(resolveTourSteps(frontDoorTourSteps(undefined)).map((s) => s.id)).toEqual(["link", "analyze"]);
  });

  it.each([
    [1, "You have 1 credit. A post costs 1 credit, however many channels it goes to, and a competitor page teardown costs 10 credits."],
    [30, "You have 30 credits. A post costs 1 credit, however many channels it goes to, and a competitor page teardown costs 10 credits."],
    [1250, "You have 1,250 credits. A post costs 1 credit, however many channels it goes to, and a competitor page teardown costs 10 credits."],
    [0, "You have 0 credits. A post costs 1 credit, however many channels it goes to, and a competitor page teardown costs 10 credits."],
  ])("shows step 3 with the widget present, for %i credits", (n, text) => {
    page(true);
    const steps = resolveTourSteps(frontDoorTourSteps(n));
    expect(steps.map((s) => s.id)).toEqual(["link", "analyze", "credits"]);
    expect(steps[2]!.title).toBe("Step 3: Your Credits");
    expect(steps[2]!.text).toBe(text);
  });

  it("uses no em or en dash", () => {
    page(true);
    for (const s of resolveTourSteps(frontDoorTourSteps(1250))) expect(`${s.title}${s.text}`).not.toMatch(/[\u2013\u2014]/);
  });
});
