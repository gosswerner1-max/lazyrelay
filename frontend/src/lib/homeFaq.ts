// The home page FAQ. This one list feeds BOTH the visible questions and the
// FAQPage structured data, so the two can never drift apart: the schema text
// must equal the visible text word for word. Every answer is 40 to 60 words and
// uses only facts stated on the site (see the optimization payload review of
// 2026-10-06) or verified in the code (the 2026-10-07 capabilities review): the 30 day
// comment and DM retention (privacySweep.ts, DPA), the AI provider (Anthropic, DPA), the
// double-send protections (scheduler.ts), the nine platforms shown in the Mentions tab
// (pages/dashboard/mentionsPlatforms.ts) and the suggested-replies safeguards (replyDrafting.ts,
// switched off for customers, so the answer says so). Plain ASCII only.
export interface FaqItem {
  q: string;
  a: string;
}

export const HOME_FAQ: FaqItem[] = [
  {
    q: "What does LazyRelay do?",
    a: "LazyRelay schedules social media posts and publishes them for you. It posts to 17 platforms, including Facebook, Instagram and TikTok. You write the post and pick when it goes out. LazyRelay then publishes it to your connected accounts automatically and independently checks that the post is live.",
  },
  {
    q: "How does Proof-of-Publish work?",
    a: "Right after publishing, LazyRelay independently checks with the platform that the post is live. It does not trust the platform's first accepted response. LazyRelay shows you the result for each post. If the check fails, the post is flagged in your dashboard, not hidden. Proof-of-Publish is included on every plan, including Free.",
  },
  {
    q: "Which platforms does LazyRelay support?",
    a: "LazyRelay supports 17 platforms, including Facebook, Instagram, TikTok, YouTube, LinkedIn, Threads, Mastodon, Bluesky, Telegram, Discord, Tumblr and Slack. It also posts to WordPress, dev.to, Hashnode and Lemmy, which are places for longer writing and communities. Mastodon works with any Mastodon server, so you type the address of yours when you connect.",
  },
  {
    q: "Is LazyRelay free?",
    a: "Yes. The Free plan costs $0 and needs no credit card. It includes 3 connected accounts, 1 brand, 250MB of storage and Proof-of-Publish verification on every post. Free covers one-time scheduled posts only, with 10 posts per account that refill over time. Paid plans add more accounts, unlimited scheduled posts and recurring schedules.",
  },
  {
    q: "How much does LazyRelay cost?",
    a: "LazyRelay charges one flat price per plan, with no fee for each connected platform. Starter is $29.99 a month, Pro is $59.99, Business is $99.99, Agency is $149.99 and Agency Plus is $199.99. Each higher plan allows more connected accounts and brands. The Free plan costs $0.",
  },
  {
    q: "Can I schedule a recurring post?",
    a: "Yes, on paid plans. A recurring schedule is one piece of content that repeats on a day and time you set. Starter includes 3 recurring schedules, Pro includes 5, and Business and above are unlimited. Each recurring schedule counts against your plan's limit. The Free plan supports one-time scheduled posts only.",
  },
  {
    q: "Does LazyRelay work with AI assistants?",
    a: "Yes. AI-agent and MCP access is included on every plan, including Free, at no extra cost. You can ask an AI assistant or editor to schedule a post, or to check that a post really went live. LazyRelay offers 15 setup guides, including Claude, ChatGPT, Cursor and n8n.",
  },
  {
    q: "What happens if a post fails to publish?",
    a: "LazyRelay does not mark a post as done just because it was sent. It separately verifies that the post is live. If that check fails, you see the post flagged in your dashboard, not silently hidden. LazyRelay also tells you before a post is scheduled if a file is too big for a platform.",
  },
  {
    q: "How long does LazyRelay keep comments and direct messages?",
    a: "LazyRelay keeps a copy of comments and direct messages for up to 30 days so they can show in your dashboard. A scheduled job then deletes them. After that, only a short classification remains, such as a category and a one-line reason. When you disconnect an account, LazyRelay also erases its stored login.",
  },
  {
    q: "Which AI does LazyRelay use?",
    a: "LazyRelay's AI features run on Anthropic's Claude models. They cover caption and hashtag suggestions, content ideas, analytics insights, comment sorting and the support assistant. AI output is a draft for you to review. Our Data Processing Agreement states that Anthropic does not train its models on this data.",
  },
  {
    q: "Can LazyRelay post the same thing twice?",
    a: "LazyRelay is built to prevent it. A due post is claimed by one worker before anything is sent, so two workers cannot send it. If a platform accepted a post but the live check did not finish, LazyRelay checks again instead of publishing twice. A post it cannot confirm is shown as failed, so you can check the platform.",
  },
  {
    q: "Does LazyRelay reply to comments by itself?",
    a: "No. LazyRelay never replies to a comment on its own. AI sorts incoming comments into categories such as needs attention, and you choose what to answer. In the dashboard you can reply to Mastodon and Bluesky comments directly. On other platforms, you reply on the platform itself.",
  },
  {
    q: "Does LazyRelay have social listening?",
    a: "LazyRelay listens to comments on the posts you publish through it. It reads them from 9 platforms into one inbound stream: dev.to, Hashnode, YouTube, Mastodon, Bluesky, Lemmy, WordPress, Telegram and Discord. Facebook, Instagram and Threads are coming soon. It does not track mentions elsewhere on the web. Comments are kept for up to 30 days.",
  },
  {
    q: "Are AI-suggested replies protected against prompt injection?",
    a: "AI-suggested replies are not available yet. In that feature, comment text reaches the AI as quoted data with angle brackets neutralised. A suggestion may only use numbers and links from your own material, comments about refunds, legal or security matters get none, and nothing posts until you approve it. These checks belong to that feature only.",
  },
];

export function homeFaqSchema(items: FaqItem[] = HOME_FAQ) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

// Safe to place inside a script tag: a literal "<" can never close the tag early.
export function homeFaqSchemaJson(items: FaqItem[] = HOME_FAQ): string {
  return JSON.stringify(homeFaqSchema(items)).replace(/</g, "\\u003c");
}
