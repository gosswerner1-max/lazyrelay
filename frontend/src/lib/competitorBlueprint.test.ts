import { describe, expect, it } from "vitest";
import {
  BASED_ON_TEXT,
  CTA_PLACEMENT_LABELS,
  HOOK_LABELS,
  blueprintToText,
  ctaLine,
  hookLabel,
  readBlueprint,
  type CompetitorBlueprint,
} from "./competitorBlueprint";

const DASH = /[\u2013\u2014]/;

const good = {
  kind: "page",
  sourceUrl: "https://rival.example/guide",
  title: "Rival guide",
  blueprint: {
    hook: { type: "question", note: "It asks if you are tired of slow posting." },
    sections: [
      { order: 2, role: "Proof", summary: "Shows three customer quotes." },
      { order: 1, role: "Problem", summary: "Explains how slow posting wastes time." },
    ],
    cta: { placement: "bottom", style: "A single button", count: 1 },
    adjustments: ["Open with a question too.", "Move your proof higher."],
  },
  creditsUsed: 1,
};

describe("the plain word labels", () => {
  const hooks = ["question", "statistic", "bold_claim", "story", "how_to", "list", "problem_agitate", "social_proof", "offer", "other"] as const;
  const places = ["top", "middle", "bottom", "multiple", "none"] as const;

  it.each(hooks)("has a plain label for the %s hook", (type) => {
    const label = hookLabel(type);
    expect(label.length).toBeGreaterThan(5);
    expect(label).not.toMatch(/_/);
    expect(label).not.toMatch(DASH);
    expect(label).toBe(HOOK_LABELS[type]);
  });

  it("says the common ones the way the owner asked", () => {
    expect(hookLabel("question")).toBe("Opens with a question");
    expect(hookLabel("statistic")).toBe("Opens with a statistic");
  });

  it.each(places)("has a plain label for the %s call to action place", (p) => {
    expect(CTA_PLACEMENT_LABELS[p].length).toBeGreaterThan(5);
    expect(CTA_PLACEMENT_LABELS[p]).not.toMatch(/_|\bCTA\b/);
  });

  it("describes the call to action in one plain line", () => {
    expect(ctaLine({ placement: "bottom", style: "A single button", count: 1 })).toBe("At the bottom. A single button. One action link found.");
    expect(ctaLine({ placement: "multiple", style: "Links", count: 17 })).toBe("In several places. Links. About 17 action links found on the page (some repeat).");
    expect(ctaLine({ placement: "bottom", style: "A button", count: 0 })).toBe("At the bottom. A button. No action links found.");
    expect(ctaLine({ placement: "none", style: "", count: 0 })).toBe("No clear call to action.");
    expect(ctaLine({ placement: "bottom", style: "A single button", count: 2 })).not.toMatch(/asked|times?/i);
  });
});

describe("readBlueprint", () => {
  it("reads a good answer and puts the sections in order", () => {
    const out = readBlueprint(good)!;
    expect(out.title).toBe("Rival guide");
    expect(out.blueprint.sections.map((s) => s.order)).toEqual([1, 2]);
    expect(out.blueprint.hook.type).toBe("question");
    expect(out.blueprint.adjustments).toHaveLength(2);
    expect(out.creditsUsed).toBe(1);
  });

  it.each([
    ["not an object", "x"],
    ["no blueprint", { ...good, blueprint: undefined }],
    ["wrong kind", { ...good, kind: "youtube" }],
    ["credits not a number", { ...good, creditsUsed: "1" }],
    ["title missing", { ...good, title: undefined }],
    ["source missing", { ...good, sourceUrl: 4 }],
  ])("refuses an answer that is %s", (_n, body) => {
    expect(readBlueprint(body)).toBeNull();
  });

  it("keeps partial data: a missing hook, call to action and lists become empty, not a crash", () => {
    const out = readBlueprint({ ...good, blueprint: {} })!;
    expect(out.blueprint.hook).toEqual({ type: "other", note: "" });
    expect(out.blueprint.sections).toEqual([]);
    expect(out.blueprint.cta).toEqual({ placement: "none", style: "", count: 0 });
    expect(out.blueprint.adjustments).toEqual([]);
  });

  it("treats a hook or place it does not know as other or none, and drops broken sections and adjustments", () => {
    const out = readBlueprint({
      ...good,
      blueprint: {
        hook: { type: "brand_new_kind", note: 5 },
        sections: [{ order: 1, role: "A", summary: "ok" }, { order: "x", role: "B", summary: "bad" }, null, { order: 3, role: 9, summary: "bad" }],
        cta: { placement: "sideways", style: 3, count: -2 },
        adjustments: ["Keep this", 7, null],
      },
    })!;
    expect(out.blueprint.hook).toEqual({ type: "other", note: "" });
    expect(out.blueprint.sections).toEqual([{ order: 1, role: "A", summary: "ok" }]);
    expect(out.blueprint.cta).toEqual({ placement: "none", style: "", count: 0 });
    expect(out.blueprint.adjustments).toEqual(["Keep this"]);
  });
});

describe("blueprintToText", () => {
  const result = readBlueprint(good) as CompetitorBlueprint;
  const text = blueprintToText(result);

  it("holds both columns, the page and the honest line", () => {
    expect(text).toContain("Competitor structure");
    expect(text).toContain("Recommended adjustments");
    expect(text).toContain("Rival guide");
    expect(text).toContain("https://rival.example/guide");
    expect(text).toContain("Opens with a question");
    expect(text).toContain("It asks if you are tired of slow posting.");
    expect(text).toContain("1. Problem: Explains how slow posting wastes time.");
    expect(text).toContain("2. Proof: Shows three customer quotes.");
    expect(text).toContain("At the bottom. A single button. One action link found.");
    expect(text).toContain("- Open with a question too.");
    expect(text).toContain("- Move your proof higher.");
    expect(text.trim().endsWith(BASED_ON_TEXT)).toBe(true);
    expect(BASED_ON_TEXT).toBe("Based on the public text of the page. AI can make mistakes.");
  });

  it("has no dash of the em or en kind, no secret-looking words and no draft talk", () => {
    expect(text).not.toMatch(DASH);
    expect(text).not.toMatch(/token|bearer|draft|successful|proven/i);
  });

  it("copes with an empty blueprint", () => {
    const empty = blueprintToText(readBlueprint({ ...good, blueprint: {} })!);
    expect(empty).toContain("No clear sections were found.");
    expect(empty).toContain("No changes to suggest for this page.");
    expect(empty).toContain("No clear call to action.");
  });
});
