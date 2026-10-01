import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PlatformIcon } from "./PlatformIcon";
import { carouselPlan } from "../lib/carousel";

// Vitest globals are off here, so testing-library does not auto-clean between tests.
afterEach(cleanup);

describe("Slack in the platform picker", () => {
  it("has its own icon, not the generic circle used for unknown platforms", () => {
    const { container: slack } = render(<PlatformIcon platform="slack" size={20} />);
    const { container: unknown } = render(<PlatformIcon platform="nonexistent" size={20} />);
    // Slack's four brand colours, as four separate pieces of the mark.
    expect([...slack.querySelectorAll("svg path")].map((p) => p.getAttribute("fill"))).toEqual(["#E01E5A", "#36C5F0", "#2EB67D", "#ECB22E"]);
    expect(unknown.querySelector("svg circle")).toBeTruthy();
  });

  it("is text only: it adds no extra-image slots to the composer", () => {
    expect(carouselPlan(["slack"]).available).toBe(false);
  });
});
