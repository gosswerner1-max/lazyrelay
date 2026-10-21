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
    a: "LazyRelay schedules social media posts and publishes them for you. It posts to 18 distribution platforms plus WhatsApp, including Facebook, Instagram and TikTok. You write the post and pick when it goes out. LazyRelay then publishes it to your connected accounts automatically and independently checks that the post is live.",
  },
  {
    q: "How does Proof-of-Publish work?",
    a: "Right after publishing, LazyRelay independently checks with the platform that the post is live. It does not trust the platform's first accepted response. LazyRelay shows you the result for each post. If the check fails, the post is flagged in your dashboard, not hidden. Proof-of-Publish is included on every plan, including Free.",
  },
  {
    q: "Which platforms does LazyRelay support?",
    a: "LazyRelay supports 18 distribution platforms plus WhatsApp. These include Facebook, Instagram, TikTok, YouTube, LinkedIn, Mastodon, Bluesky, Telegram, Discord, Slack and X, plus WordPress, dev.to, Hashnode and Lemmy for longer writing. X connects with your own X developer keys on a paid plan, and X bills your developer account. WhatsApp is client messaging, connected with your own Meta credentials.",
  },
  {
    q: "Is LazyRelay free?",
    a: "Yes. The Free plan costs $0 and gives you 30 credits once, when you register, with no monthly reset. It includes 3 connected accounts, 1 brand and 10 queued posts, plus Proof-of-Publish verification on every post. When the credits run out, you can add more with a credit pack or a paid plan.",
  },
  {
    q: "How much does LazyRelay cost?",
    a: "LazyRelay runs on credits. One credit publishes to one channel, so a post to 5 channels costs 5 credits. A competitor teardown costs 10 credits. Pay-as-you-go is $15 one time, Growth is $29 a month and Pro is $99 a month. Credit packs start at $15.",
  },
  {
    q: "Can I schedule a recurring post?",
    a: "Yes. A recurring schedule is one piece of content that repeats on a day and time you set. Each time it publishes, it uses credits like any other post, at 1 credit for each channel. If your credits run out, due posts wait and publish once you add credits.",
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
    a: "On paid plans, LazyRelay can draft replies to Mastodon and Bluesky comments. Comment text reaches the AI as quoted data with angle brackets neutralised. A draft may only use numbers from your material or the comment, and links from your material only. Refund, legal and security comments get no draft, and nothing posts until you approve it.",
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
