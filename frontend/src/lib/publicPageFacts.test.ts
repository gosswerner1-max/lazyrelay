import { describe, expect, it } from "vitest";
// The frontend has no Node typings (tsc -b checks test files too), so every file this reads comes in with Vite's ?raw import.
import mastodonPage from "../../public/schedule-to-mastodon/index.html?raw";
import channelGenerator from "../../scripts/generate-channel-pages.mjs?raw";
import channelManifest from "../../scripts/channel-pages-manifest.json?raw";
import platformFeatures from "../../public/platform-features/index.html?raw";
import changelog from "../../public/changelog/index.html?raw";
import changelogFeed from "../../public/changelog.xml?raw";
import docsPage from "../../public/docs/index.html?raw";
import dataDeletionStatic from "../../public/data-deletion/index.html?raw";
import refundsPage from "../../public/refunds/index.html?raw";
import connectZapier from "../../public/connect-zapier/index.html?raw";
import inTheWorks from "../../public/in-the-works/index.html?raw";
import postdodo from "../../public/alternatives/postdodo/index.html?raw";
import metricool from "../../public/alternatives/metricool/index.html?raw";
import sprout from "../../public/alternatives/sprout-social/index.html?raw";
import apiDocsTsx from "../pages/ApiDocs.tsx?raw";
import apiKeysTabTsx from "../pages/dashboard/ApiKeysTab.tsx?raw";
import termsTsx from "../pages/TermsOfService.tsx?raw";
import privacyTsx from "../pages/PrivacyPolicy.tsx?raw";
import mcpClaude from "../../public/mcp/claude/index.html?raw";
import mcpCodex from "../../public/mcp/codex-cli/index.html?raw";
import mcpCursor from "../../public/mcp/cursor/index.html?raw";
import mcpGemini from "../../public/mcp/gemini-cli/index.html?raw";
import mcpMake from "../../public/mcp/make/index.html?raw";
import mcpN8n from "../../public/mcp/n8n/index.html?raw";
import mcpVscode from "../../public/mcp/vscode/index.html?raw";
import mcpWindsurf from "../../public/mcp/windsurf/index.html?raw";

// The mcp-server, zapier-integration and backend script text is checked by backend/src/publicTextFacts.test.ts (Vite will not
// serve files outside the frontend folder).
// Facts checked against the code on 2026-10-15 (see the PR body for the evidence behind each one). Each block asserts
// that a wrong public statement is gone and that the corrected fact is in its place.

/** The cells of one table row in platform-features, keyed by the platform name in the first cell. */
function featureRow(platform: string): string[] {
  const row = platformFeatures.split("\n").find((l) => l.startsWith(`<tr><td>${platform}</td>`));
  if (!row) throw new Error(`no row for ${platform}`);
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
}
const TICK = "&#10003;";

describe("item 2: Mastodon accepts any server", () => {
  it.each([
    ["page", mastodonPage],
    ["generator", channelGenerator],
    ["manifest", channelManifest],
  ])("%s no longer says Mastodon connects to mastodon.social only", (_name, text) => {
    expect(text).not.toMatch(/connects to mastodon\.social only/i);
    expect(text).not.toContain("cannot be connected yet");
    expect(text).not.toContain("Not yet. LazyRelay connects");
    expect(text).not.toContain("Connects to mastodon.social.");
    expect(text).not.toContain("account on mastodon.social, then");
  });
  it("page and generator both say any server works", () => {
    expect(mastodonPage).toContain("Mastodon works with any server");
    expect(channelGenerator).toContain("Mastodon works with any server");
    expect(mastodonPage).toContain("Yes. LazyRelay works with any Mastodon server.");
    expect(channelGenerator).toContain("Yes. LazyRelay works with any Mastodon server.");
  });
  it("page and manifest carry the same description", () => {
    const desc = "Works with any server. Each post is read back";
    expect(mastodonPage).toContain(desc);
    expect(channelManifest).toContain(desc);
    expect(channelGenerator).toContain(desc);
  });
});

describe("item 3: platform-features table matches what is live", () => {
  it.each(["Telegram", "Discord", "WordPress", "dev.to", "Hashnode", "Lemmy"])("%s shows comments as read", (p) => {
    expect(featureRow(p)[3]).toContain(TICK);
  });
  it.each(["dev.to", "Hashnode", "Lemmy"])("%s shows engagement analytics (getPostMetrics exists)", (p) => {
    expect(featureRow(p)[2]).toContain(TICK);
  });
  it.each(["Threads", "TikTok", "Pinterest", "LinkedIn", "Tumblr", "Slack"])("%s has no comments or analytics claim", (p) => {
    expect(featureRow(p)[2]).not.toContain(TICK);
    expect(featureRow(p)[3]).not.toContain(TICK);
  });
  it("Facebook and Instagram comment cells say coming soon, not a bare tick", () => {
    for (const p of ["Facebook", "Instagram"]) {
      expect(featureRow(p)[3]).toContain("coming soon");
      expect(featureRow(p)[4]).toContain("coming soon");
    }
  });
  it("does not say the whole Mentions tab is switched off", () => {
    expect(platformFeatures).not.toContain("the Mentions and DMs tabs stay switched off");
    expect(platformFeatures).not.toContain("Comments (read)<br>coming soon");
    expect(platformFeatures).toContain("The Mentions tab is open");
    expect(platformFeatures).toContain("dev.to, Hashnode, YouTube, Mastodon, Bluesky, Lemmy, WordPress, Telegram and Discord");
    expect(platformFeatures).toContain("The DMs tab");
  });
});

describe("item 12: changelog no longer says the Facebook and Instagram inboxes shipped", () => {
  it.each([
    ["page", changelog],
    ["feed", changelogFeed],
  ])("%s", (_name, text) => {
    expect(text).not.toContain("Comments inbox extended to Facebook and Instagram, with reply capability added across Facebook, Instagram, Mastodon, and Bluesky.");
    expect(text).not.toMatch(/DM inbox for Facebook and Instagram\.(<|\s*\|)/);
    expect(text).toContain("switched off until Meta approves");
  });
});

describe("item 5: dashboard navigation text", () => {
  it("API Keys is a main tab, not under More or Settings", () => {
    for (const [name, text] of [
      ["docs page", docsPage],
      ["ApiDocs.tsx", apiDocsTsx],
      ["connect-zapier", connectZapier],
    ] as const) {
      expect(text, name).not.toMatch(/More (&rarr;|→|->) API Keys/);
      expect(text, name).not.toMatch(/Settings (&rarr;|→|->) (More (&rarr;|→|->) )?API Keys/);
    }
    expect(docsPage).toContain("API Keys tab");
    expect(apiDocsTsx).toContain("API Keys tab");
  });
  it.each([
    ["claude", mcpClaude],
    ["codex-cli", mcpCodex],
    ["cursor", mcpCursor],
    ["gemini-cli", mcpGemini],
    ["make", mcpMake],
    ["n8n", mcpN8n],
    ["vscode", mcpVscode],
    ["windsurf", mcpWindsurf],
    ["connect-zapier", connectZapier],
  ])("MCP page %s points at the API Keys tab, not the Settings tab", (_name, text) => {
    expect(text).not.toContain("from your dashboard's Settings tab");
    expect(text).toContain("from the API Keys tab of your dashboard");
  });
  it("Billing sits in the Settings tab, not under More", () => {
    for (const text of [dataDeletionStatic, refundsPage]) {
      expect(text).not.toContain("under More in the top nav");
      expect(text).toContain("Billing section of the Settings tab");
    }
  });
});

describe("item 6: the MCP server has 27 tools", () => {
  it("no page or readme says 6 or 24 tools", () => {
    expect(apiDocsTsx).not.toMatch(/Same (6|24) tools/);
    expect(apiKeysTabTsx).not.toMatch(/Same (6|24) tools/);
    expect(apiDocsTsx).toContain("Same 27 tools");
    expect(apiKeysTabTsx).toContain("Same 27 tools");
  });
});

describe("item 7: partner program terms", () => {
  it("states the real commission and that applications are open", () => {
    expect(inTheWorks).not.toContain("30% lifetime");
    expect(inTheWorks).not.toContain("Not yet open for anyone to join");
    expect(inTheWorks).toContain("20% for 12 months");
    expect(inTheWorks).toContain("30% for the first 3 months, then 20% for the next 9");
    expect(inTheWorks).toContain('href="/partners"');
  });
});

describe("item 8: static data-deletion page agrees with the React page", () => {
  it("cancelling does delete posts and media 30 days after access ends", () => {
    expect(dataDeletionStatic).not.toContain("Cancelling does not, by itself, delete your data.");
    expect(dataDeletionStatic).toContain("30 days after your access");
    expect(dataDeletionStatic).toContain("permanently deleted");
  });
});

describe("item 9: competitor comparison lines", () => {
  it("API access is on every plan including Free", () => {
    expect(postdodo).not.toContain("<strong>Yes, on paid plans</strong>");
    expect(postdodo).toContain("<tr><td>API access</td><td><strong>Yes, on every plan including Free</strong>");
  });
  it("LazyRelay Free includes LinkedIn and Threads", () => {
    expect(metricool).not.toContain("LazyRelay's Free plan doesn't include LinkedIn");
    expect(metricool).not.toContain("LazyRelay's Free plan doesn't include LinkedIn's newer alternatives");
    expect(metricool).toContain("LazyRelay's Free plan includes LinkedIn");
    expect(metricool).toMatch(/Platforms on free plan<\/td><td><strong>[^<]*LinkedIn, Threads/);
  });
  it("LazyRelay has monthly billing only", () => {
    expect(sprout).not.toContain("or yearly if you choose the discount");
    expect(sprout).toContain("a paid plan is month-to-month");
  });
});

describe("item 10: terms and privacy", () => {
  it("terms list all five paid plans", () => {
    expect(termsTsx).not.toContain("Paid plans (Starter, Pro, Business) and");
    expect(termsTsx).toContain("Paid plans (Starter, Pro, Business, Agency, Agency Plus)");
  });
  it("privacy does not claim private messages are never read", () => {
    expect(privacyTsx).not.toContain("We never read your");
    expect(privacyTsx).toMatch(/direct\s+messages/);
  });
});

describe("guard rails for this change", () => {
  it("the page fix did not add dashes as punctuation to the sentences it touched", () => {
    expect(inTheWorks).not.toMatch(/20% for 12 months[^<]* [—–-] /);
  });
});
