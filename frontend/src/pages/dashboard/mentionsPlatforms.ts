// Platforms whose comments the Mentions tab shows: dev.to, Hashnode, Mastodon,
// Bluesky, YouTube, Lemmy, WordPress, Telegram and Discord. None of them depends on a Meta permission. The
// dashboard sends this list to GET /mentions (?platforms=), so the server picks the newest
// 15 posts of THESE platforms instead of the newest 15 of everything.
export const MENTIONS_LIVE_PLATFORMS: readonly string[] = ["devto", "hashnode", "mastodon", "bluesky", "youtube", "lemmy", "wordpress", "telegram", "discord"];

// The only platforms that get a "Coming soon" row in the Mentions tab: Facebook, Instagram and Threads are waiting
// on Meta app reviews (Werner, 2026-10-07). Platforms with no usable comment API (TikTok, Pinterest, Tumblr, Slack)
// are not listed at all; their posting is unaffected.
export const MENTIONS_COMING_SOON_PLATFORMS: readonly string[] = ["facebook", "instagram", "threads"];
