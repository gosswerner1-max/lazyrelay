import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PlatformIcon, BRAND_COLORS } from "./PlatformIcon";
import { carouselPlan } from "../lib/carousel";

// Vitest globals are off here, so testing-library does not auto-clean between tests.
afterEach(cleanup);

describe("Slack in the platform picker", () => {
  it("has its own icon, not the generic circle used for unknown platforms", () => {
    const { container: slack } = render(<PlatformIcon platform="slack" size={20} />);
    const { container: unknown } = render(<PlatformIcon platform="nonexistent" size={20} />);
    expect(slack.querySelector("svg text")?.textContent).toBe("#");
    expect(slack.querySelector("svg rect")?.getAttribute("fill")).toBe(BRAND_COLORS.slack);
    expect(unknown.querySelector("svg circle")).toBeTruthy();
  });

  it("is text only: it adds no extra-image slots to the composer", () => {
    expect(carouselPlan(["slack"]).available).toBe(false);
  });
});
