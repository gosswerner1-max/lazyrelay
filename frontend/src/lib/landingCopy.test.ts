import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import landing from "../pages/Landing.tsx?raw";

// Fact guard for the two capability lines added to the landing page on 2026-10-19. Each line is checked against what the product
// really does (the 27 MCP tools, the Content Sources tab text) and against the copy rules: no dash or hyphen, no blue.
//   MCP: 27 tools in lazyrelayTools.ts, included on every plan; setup guides for 15 AI agents at lazyrelay.com/mcp/.
//   Content Sources: RSS feeds and sitemaps from a website the customer has proven they own, drafts only, nothing posts until approved.

const guard = createRequire(import.meta.url)("../../../scripts/check-copy-guardrails.js") as { checkHtml: (html: string) => string[] };

const MCP_LINE =
  "AI agent access: 27 MCP tools, included on every plan, that work with any AI agent that supports MCP, including Claude, ChatGPT, Gemini and Cursor";
const SOURCES_LINE =
  "Content Sources: connect an RSS feed or a sitemap from a website you have proven you own, and LazyRelay turns new pages into draft posts for you to review. Nothing is posted until you approve it";

describe("the two new capability lines", () => {
  it("are on the landing page exactly as approved", () => {
    expect(landing).toContain(`"${MCP_LINE}"`);
    expect(landing).toContain(`"${SOURCES_LINE}"`);
  });

  it("hold no dash, no hyphen and no blue", () => {
    for (const line of [MCP_LINE, SOURCES_LINE]) {
      expect(guard.checkHtml(`<html><body><main><li>${line}</li></main></body></html>`), line).toEqual([]);
    }
  });
});

describe("claims the product cannot back never appear on the landing page", () => {
  it.each([
    ["a model agnostic layer (no such feature exists)", /model[ -]agnostic/i],
    ["no central database (LazyRelay stores data in its database)", /without central (cloud )?database/i],
    ["zero trust (not a verified product claim)", /zero[ -]trust/i],
    ["OpenAI token optimisation (not a verified product claim)", /optimi[sz]ed for OpenAI/i],
    ["a shadow log feature (an internal test, not a customer feature)", /shadow log/i],
    ["an Enterprise WhatsApp plan (there is no Enterprise plan)", /Enterprise WhatsApp/i],
  ])("%s", (_why, pattern) => {
    expect(landing).not.toMatch(pattern);
  });
});
