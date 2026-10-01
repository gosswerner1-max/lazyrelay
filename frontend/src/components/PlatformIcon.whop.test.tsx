import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PlatformIcon, BRAND_COLORS } from "./PlatformIcon";
import { carouselPlan } from "../lib/carousel";

afterEach(cleanup);

describe("Whop in the platform picker", () => {
  it("has its own mark (an orange tile with a white W), not the generic circle used for unknown platforms", () => {
    const { container: whop } = render(<PlatformIcon platform="whop" size={20} />);
    const { container: unknown } = render(<PlatformIcon platform="nonexistent" size={20} />);
    expect(BRAND_COLORS.whop).toBe("#FA4616");
    expect(whop.querySelector("svg rect")?.getAttribute("fill")).toBe("#FA4616");
    expect(whop.querySelector("svg path")?.getAttribute("stroke")).toBe("#fff");
    expect(whop.querySelector("svg circle[fill='none']")).toBeNull(); // the placeholder is a hollow circle
    expect(unknown.querySelector("svg circle")?.getAttribute("fill")).toBe("none");
  });

  it("is text only: it adds no extra-image slots to the composer", () => {
    expect(carouselPlan(["whop"]).available).toBe(false);
  });
});
