import { describe, it, expect } from "vitest";
// The frontend has no Node typings (tsc -b checks test files too), so the two files this reads come in with Vite's ?raw import.
import indexHtml from "../../index.html?raw";
import platformFeaturesHtml from "../../public/platform-features/index.html?raw";
import { PUBLISHING_PLATFORMS, MCP_TOOL_COUNT, commentFeedPlatforms, homeSoftwareFeatures, homeSoftwareDescriptionSentence } from "./homeSchema";
import { MENTIONS_LIVE_PLATFORMS } from "../pages/dashboard/mentionsPlatforms";

interface GraphNode {
  "@type": string;
  "@id"?: string;
  description?: string;
  featureList?: string[];
  offers?: unknown;
  aggregateRating?: unknown;
  review?: unknown;
}

/** The JSON-LD @graph from the home page shell, parsed the way a crawler would. */
function homeGraph(): GraphNode[] {
  const blocks = [...indexHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const withGraph = blocks.find((b) => Array.isArray(b["@graph"]));
  expect(withGraph, "index.html must hold a JSON-LD @graph").toBeTruthy();
  return withGraph["@graph"] as GraphNode[];
}

describe("home page SoftwareApplication node (index.html)", () => {
  const graph = homeGraph();
  const software = graph.filter((n) => n["@type"] === "SoftwareApplication");

  it("there is exactly one SoftwareApplication, so crawlers never see two competing descriptions", () => {
    expect(software).toHaveLength(1);
    expect(software[0]["@id"]).toBe("https://lazyrelay.com/#software");
  });

  it("states every platform and developer fact the typed module defines, word for word", () => {
    const node = software[0];
    for (const line of homeSoftwareFeatures()) expect(node.featureList, line).toContain(line);
    expect(node.description).toContain(homeSoftwareDescriptionSentence());
  });

  it("keeps its plans and prices, and makes up no rating or review", () => {
    const node = software[0];
    expect(node.offers).toBeTruthy();
    expect(node.aggregateRating).toBeUndefined();
    expect(node.review).toBeUndefined();
    expect(JSON.stringify(node)).not.toContain("ratingValue");
  });

  it("is plain ASCII, makes no ranking claim, does not call the product AI-driven, and keeps listening scoped to the customer's own posts", () => {
    const text = JSON.stringify(software[0]);
    expect(/^[\x20-\x7E]+$/.test(text)).toBe(true);
    for (const bad of ["best", "fastest", "powerful", "guarantee", "ai-driven"]) expect(text.toLowerCase().includes(bad), bad).toBe(false);
    // Listening is real, but only on comments on the customer's own posts: no claim about the wider web.
    for (const bad of ["brand mention", "across the web", "sentiment", "competitor"]) expect(text.toLowerCase().includes(bad), bad).toBe(false);
    expect(text).toContain("listens to comments on your own posts");
  });
});

describe("the facts the structured data is built from", () => {
  it("lists exactly the 17 publishing platforms, each once", () => {
    expect(PUBLISHING_PLATFORMS).toHaveLength(17);
    expect(new Set(PUBLISHING_PLATFORMS).size).toBe(17);
  });

  it("every publishing platform is named on the public platform-features page", () => {
    const page = platformFeaturesHtml.toLowerCase();
    for (const name of PUBLISHING_PLATFORMS) expect(page.includes(name.toLowerCase()), name).toBe(true);
  });

  it("lists exactly the platforms the Mentions tab shows comments for, and none that are Coming soon", () => {
    const feed = commentFeedPlatforms();
    expect(feed).toHaveLength(9);
    expect(feed).toHaveLength(MENTIONS_LIVE_PLATFORMS.length);
    for (const name of ["Facebook", "Instagram", "Threads"]) expect(feed).not.toContain(name);
  });

  it("refuses a Mentions platform it has no display name for, instead of silently dropping it", () => {
    expect(() => commentFeedPlatforms(["devto", "someNewPlatform"])).toThrow(/someNewPlatform/);
  });

  it("states an MCP tool count (the backend test checks it equals the number of tools the server registers)", () => {
    expect(MCP_TOOL_COUNT).toBeGreaterThan(0);
  });
});
