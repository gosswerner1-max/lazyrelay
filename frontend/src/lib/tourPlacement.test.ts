import { describe, expect, it } from "vitest";
import { computePlacement } from "./tourPlacement";

const pop = { width: 320, height: 160 };

describe("computePlacement", () => {
  it("goes below the target when it fits, with the arrow under the target centre", () => {
    const p = computePlacement({ top: 100, left: 200, width: 100, height: 40 }, pop, { width: 1366, height: 600 });
    expect(p.side).toBe("below");
    expect(p.top).toBe(100 + 40 + 12);
    expect(p.left).toBe(250 - 160);
    expect(p.arrowLeft).toBe(160);
    expect(p.width).toBe(320);
  });

  it("flips above when there is no room below but room above (1366x600)", () => {
    const p = computePlacement({ top: 470, left: 400, width: 200, height: 40 }, pop, { width: 1366, height: 600 });
    expect(p.side).toBe("above");
    expect(p.top).toBe(470 - 12 - 160);
  });

  it("flips above in a 1280x560 window for a target near the bottom", () => {
    const p = computePlacement({ top: 430, left: 100, width: 120, height: 36 }, pop, { width: 1280, height: 560 });
    expect(p.side).toBe("above");
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(430 - 12);
  });

  it("clamps the left edge inside the viewport and moves the arrow to keep pointing at the target", () => {
    const p = computePlacement({ top: 50, left: 0, width: 40, height: 40 }, pop, { width: 1366, height: 600 });
    expect(p.left).toBe(8);
    expect(p.arrowLeft).toBe(16);
  });

  it("clamps the right edge", () => {
    const p = computePlacement({ top: 50, left: 1340, width: 20, height: 40 }, pop, { width: 1366, height: 600 });
    expect(p.left).toBe(1366 - 320 - 8);
    expect(p.arrowLeft).toBeLessThanOrEqual(320 - 16);
    expect(p.arrowLeft).toBeGreaterThanOrEqual(16);
  });

  it("shrinks to the phone width (360) with an 8 px margin on each side", () => {
    const p = computePlacement({ top: 100, left: 20, width: 300, height: 40 }, { width: 400, height: 160 }, { width: 360, height: 640 });
    expect(p.width).toBe(344);
    expect(p.left).toBe(8);
  });

  it("uses the roomier side and a max height when neither side fits the whole popover", () => {
    const tall = { width: 320, height: 400 };
    const p = computePlacement({ top: 300, left: 100, width: 100, height: 40 }, tall, { width: 1366, height: 600 });
    expect(p.side).toBe("above");
    expect(p.maxHeight).toBe(300 - 12 - 8);
    expect(p.top).toBe(8);
  });

  it("goes below with a max height when below is the roomier side", () => {
    const tall = { width: 320, height: 500 };
    const p = computePlacement({ top: 100, left: 100, width: 100, height: 40 }, tall, { width: 1366, height: 600 });
    expect(p.side).toBe("below");
    expect(p.maxHeight).toBe(600 - 140 - 12 - 8);
  });

  it("pins inside the viewport with no arrow when the target leaves no usable room on either side", () => {
    const p = computePlacement({ top: 8, left: 100, width: 600, height: 560 }, pop, { width: 1366, height: 600 });
    expect(p.side).toBe("inside");
    expect(p.top).toBe(8);
    expect(p.maxHeight).toBe(600 - 16);
  });

  it("never lets the popover leave the viewport vertically", () => {
    for (const top of [0, 50, 200, 380, 520]) {
      const p = computePlacement({ top, left: 300, width: 100, height: 30 }, pop, { width: 1280, height: 560 });
      expect(p.top).toBeGreaterThanOrEqual(8);
      expect(p.top + Math.min(pop.height, p.maxHeight)).toBeLessThanOrEqual(560 - 8 + 0.0001);
    }
  });
});
