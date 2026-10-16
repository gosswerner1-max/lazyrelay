import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PlatformIcon, BRAND_COLORS } from "./PlatformIcon";

afterEach(cleanup);

// Every id the backend's platform picker can return (ALL_PLATFORMS in socialAccounts.routes.ts).
const PICKER_PLATFORMS = [
  "tiktok", "pinterest", "youtube", "mastodon", "bluesky", "telegram",
  "linkedin", "threads", "facebook", "instagram", "discord", "tumblr", "x",
  "wordpress", "devto", "hashnode", "lemmy", "slack", "nostr", "whop", "whatsapp",
];

describe("platform picker icons", () => {
  it.each(PICKER_PLATFORMS)("%s has its own mark, not the hollow placeholder circle", (platform) => {
    const { container } = render(<PlatformIcon platform={platform} size={20} />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("svg circle[fill='none']:only-child")).toBeNull();
  });

  it("WhatsApp is a green tile with a white speech bubble and handset, sized like its neighbours", () => {
    const { container } = render(<PlatformIcon platform="whatsapp" size={20} />);
    expect(BRAND_COLORS.whatsapp).toBe("#25D366");
    const svg = container.querySelector("svg") as SVGElement;
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.getAttribute("height")).toBe("20");
    expect(svg.querySelector("rect")?.getAttribute("fill")).toBe("#25D366");
    expect(svg.querySelector("path")?.getAttribute("fill")).toBe("#fff");
    expect(svg.getAttribute("aria-hidden")).toBe("true"); // the tile's text label is the accessible name
  });
});
