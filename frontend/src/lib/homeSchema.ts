// The facts the home page's SoftwareApplication structured data states about platforms and developer access.
// The JSON-LD itself lives in frontend/index.html (one @graph with the Organization, the WebSite and the single
// SoftwareApplication node); this module is the typed single source of the facts, and homeSchema.test.ts parses
// index.html and fails if the node ever says something different. That keeps the page honest as the product changes:
//   - the nine platforms whose comments the Mentions tab shows come from MENTIONS_LIVE_PLATFORMS;
//   - the 17 publishing platforms are the list the site already states everywhere (README, llms.txt, platform-features);
//     the test checks every name against the public platform-features page;
//   - the MCP tool count is checked against the generated docs/mcp-integration.md.
// Only claims that are true and checkable: no rating, no review count, no customer numbers (there are none yet).
// Plain ASCII only, like the FAQ.

import { MENTIONS_LIVE_PLATFORMS } from "../pages/dashboard/mentionsPlatforms";

export const PUBLISHING_PLATFORMS = [
  "Facebook",
  "Instagram",
  "TikTok",
  "Pinterest",
  "YouTube",
  "LinkedIn",
  "Threads",
  "Mastodon",
  "Bluesky",
  "Telegram",
  "Discord",
  "Tumblr",
  "WordPress",
  "dev.to",
  "Hashnode",
  "Lemmy",
  "Slack",
] as const;

const COMMENT_FEED_LABELS: Record<string, string> = {
  devto: "dev.to",
  hashnode: "Hashnode",
  youtube: "YouTube",
  mastodon: "Mastodon",
  bluesky: "Bluesky",
  lemmy: "Lemmy",
  wordpress: "WordPress",
  telegram: "Telegram",
  discord: "Discord",
};

/** Display names of the platforms the Mentions tab shows comments for, in the dashboard's own order. */
export function commentFeedPlatforms(ids: readonly string[] = MENTIONS_LIVE_PLATFORMS): string[] {
  return ids.map((id) => {
    const label = COMMENT_FEED_LABELS[id];
    if (!label) throw new Error(`No display name for the Mentions platform "${id}": add it to COMMENT_FEED_LABELS`);
    return label;
  });
}

export const MCP_TOOL_COUNT = 27;

/** The feature lines index.html's SoftwareApplication node must contain, word for word. */
export function homeSoftwareFeatures(): string[] {
  const feed = commentFeedPlatforms();
  return [
    `Scheduled posting to ${PUBLISHING_PLATFORMS.length} platforms: ${PUBLISHING_PLATFORMS.join(", ")}`,
    `MCP server with ${MCP_TOOL_COUNT} tools for AI agents, included on every plan, including Free`,
    "REST API described in OpenAPI 3.1",
    `Comment listening stream: reads comments on posts you publish through LazyRelay from ${feed.length} platforms in one place: ${feed.join(", ")}`,
    "Reply to Mastodon and Bluesky comments from the dashboard",
    "Comments and direct messages are kept for up to 30 days, then deleted",
    "AI caption, hashtag and content idea suggestions, labelled as drafts to review",
    "Groups connected accounts by brand and filters every view by brand",
  ];
}

/** The sentence index.html's SoftwareApplication description must contain. */
export function homeSoftwareDescriptionSentence(): string {
  return `It also listens to comments on your own posts across ${commentFeedPlatforms().length} platforms in one inbound stream and offers a REST API, an MCP server, an SDK and a command line tool for developers.`;
}
