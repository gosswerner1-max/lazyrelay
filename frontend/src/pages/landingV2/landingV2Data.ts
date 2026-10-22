// Copy and facts for the new home page. Every number here matches public/pricing.md and the live product:
// the platform count is the locked wording "18 distribution platforms plus WhatsApp", and the 27 actions are the 27 MCP tools.

export const PLATFORM_COUNT_WORDING = "18 distribution platforms plus WhatsApp";

export interface TickerPlatform {
  /** File name in public/home-icons, without the extension. */
  icon: string;
  label: string;
  /** Drawn in slate with a grayscale filter (the logo's own colour is not used on this page). */
  slate?: boolean;
}

// First lane, then second lane. 18 distribution platforms, then WhatsApp (client messaging, not distribution).
export const TICKER_LANES: TickerPlatform[][] = [
  [
    { icon: "tiktok", label: "TikTok" },
    { icon: "instagram", label: "Instagram" },
    { icon: "facebook", label: "Facebook" },
    { icon: "youtube", label: "YouTube" },
    { icon: "linkedin", label: "LinkedIn" },
    { icon: "pinterest", label: "Pinterest" },
    { icon: "mastodon", label: "Mastodon", slate: true },
    { icon: "bluesky", label: "Bluesky" },
    { icon: "threads", label: "Threads" },
    { icon: "tumblr", label: "Tumblr" },
  ],
  [
    { icon: "telegram", label: "Telegram" },
    { icon: "x", label: "X" },
    { icon: "discord", label: "Discord", slate: true },
    { icon: "wordpress", label: "WordPress" },
    { icon: "devdotto", label: "dev.to" },
    { icon: "hashnode", label: "Hashnode" },
    { icon: "lemmy", label: "Lemmy" },
    { icon: "slack", label: "Slack" },
    { icon: "whatsapp", label: "WhatsApp (messaging)" },
  ],
];

export type ActionGroupId = "lookups" | "posting" | "approval" | "results";

export interface ActionGroup {
  id: ActionGroupId;
  title: string;
  blurb: string;
  tools: string[];
}

export const ACTION_GROUPS: ActionGroup[] = [
  {
    id: "lookups",
    title: "Lookups",
    blurb: "Find out what is connected and what each platform accepts before you post.",
    tools: ["list_connected_accounts", "list_workspaces", "get_platform_rules", "get_tiktok_creator_info", "list_pinterest_boards", "get_next_free_slot", "list_posting_slots", "list_snippets"],
  },
  {
    id: "posting",
    title: "Posting",
    blurb: "Create, schedule, edit, pause and cancel posts.",
    tools: ["schedule_post", "publish_post_now", "create_draft", "schedule_draft", "update_post", "reschedule_post", "pause_post", "resume_post", "delete_scheduled_post"],
  },
  {
    id: "approval",
    title: "Client approval",
    blurb: "Approve waiting posts and run client review links and feedback.",
    tools: ["approve_post", "create_review_link", "list_review_links", "revoke_review_link", "get_post_feedback", "reply_to_post_feedback"],
  },
  {
    id: "results",
    title: "Results",
    blurb: "Check what happened: post status and Proof-of-Publish, shareable proof, analytics and comments.",
    tools: ["list_scheduled_posts", "get_proof_link", "get_analytics_summary", "get_mentions"],
  },
];

export const SCALE_BARS = [
  { plan: "Free", accounts: "3", brands: "1 brand" },
  { plan: "Pay-as-you-go", accounts: "20", brands: "2 brands" },
  { plan: "Growth", accounts: "30", brands: "4 brands" },
  { plan: "Pro", accounts: "1,000", brands: "Unlimited brands" },
];

export const STEPS = [
  { title: "Connect your accounts", body: "Link the social accounts you want to post to." },
  { title: "Schedule your content", body: "Write a one-time post, or set up a recurring weekly schedule once." },
  { title: "It happens automatically", body: "LazyRelay posts it for you and confirms it's live." },
];

export const WHY_ROWS = [
  { label: "Sent vs. live", us: "Proof-of-Publish independently confirms a post is actually live.", them: "A typical scheduler treats \"sent\" as done." },
  { label: "Platform coverage", us: `${PLATFORM_COUNT_WORDING}, including Mastodon, Bluesky, Telegram, Discord, Tumblr, WordPress, dev.to, Hashnode, Lemmy, Slack and X.`, them: "A typical scheduler usually stops at the big four or five." },
  { label: "Getting started", us: "A free tier with 30 credits to start.", them: "A card is often required just to try a typical scheduler." },
];

// Same text as the current home page and pricing.md.
export const PRO_TOP_UP_TEXT = "$30 for 1,500 credits (bound to active subscription status, expires if canceled).";

export interface PlanCard {
  name: string;
  price: string;
  period?: string;
  sub?: string;
  benefit: string;
  features: string[];
  cta: string;
  ghost?: boolean;
  raise?: boolean;
}

export const PLANS: PlanCard[] = [
  {
    name: "Free",
    price: "$0",
    sub: "No card to start",
    benefit: "Try the whole product with 30 credits.",
    features: ["30 credits once, at registration", "3 connected accounts, 1 brand", "10 queued posts", "AI-agent and MCP access"],
    cta: "Get started free",
    ghost: true,
  },
  {
    name: "Pay-as-you-go",
    price: "$15",
    period: "one time",
    benefit: "Pay once. Your credits never expire.",
    features: ["300 credits, kept until used", "20 connected accounts, 2 brands", "WhatsApp and X with your own keys", "Top up any time"],
    cta: "Buy 300 credits",
  },
  {
    name: "Growth",
    price: "$29",
    period: "a month",
    benefit: "1,000 fresh credits every billing cycle.",
    features: ["1,000 credits each cycle, no rollover", "30 connected accounts, 4 brands", "WhatsApp and X with your own keys", "Extra credit packs available"],
    cta: "Choose Growth",
    raise: true,
  },
  {
    name: "Pro",
    price: "$99",
    period: "a month",
    benefit: "6,000 credits a cycle and unlimited brands.",
    features: ["6,000 credits each cycle, no rollover", "Up to 1,000 connected accounts", "Unlimited brands", `Pro top-up: ${PRO_TOP_UP_TEXT}`],
    cta: "Choose Pro",
  },
];
