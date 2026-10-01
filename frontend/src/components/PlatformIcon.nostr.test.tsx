import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PlatformIcon, BRAND_COLORS } from "./PlatformIcon";
import { carouselPlan } from "../lib/carousel";

afterEach(cleanup);

describe("Nostr in the platform picker", () => {
  it("has its own mark (a purple tile with a white ostrich), not the generic circle used for unknown platforms", () => {
    const { container: nostr } = render(<PlatformIcon platform="nostr" size={20} />);
    const { container: unknown } = render(<PlatformIcon platform="nonexistent" size={20} />);
    expect(BRAND_COLORS.nostr).toBe("#8E30EB");
    expect(nostr.querySelector("svg rect")?.getAttribute("fill")).toBe("#8E30EB");
    expect(nostr.querySelectorAll("svg path, svg ellipse, svg circle").length).toBeGreaterThanOrEqual(4);
    expect(nostr.querySelector("svg circle[fill='none']")).toBeNull(); // the placeholder is a hollow circle
    expect(unknown.querySelector("svg circle")?.getAttribute("fill")).toBe("none");
  });

  it("is text only: it adds no extra-image slots to the composer", () => {
    expect(carouselPlan(["nostr"]).available).toBe(false);
  });
});
