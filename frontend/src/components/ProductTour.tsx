import { Joyride, type EventData } from "react-joyride";

const TOUR_STEPS = [
  {
    target: "body",
    placement: "center" as const,
    disableBeacon: true,
    content: "Welcome to LazyRelay. Here's where everything lives, in under a minute.",
  },
  {
    target: '[data-tour="tab-social-platforms"]',
    content:
      "Connect your accounts here. Facebook, Instagram, TikTok, Pinterest, YouTube, LinkedIn, Threads, Mastodon, Bluesky, Telegram, Discord, and Tumblr, all in one place.",
  },
  {
    target: '[data-tour="tab-posts"]',
    content:
      "Schedule a post here. Once it's due, LazyRelay's Proof-of-Publish independently checks that the post actually went live, not just that the platform's API accepted the request.",
  },
  {
    target: '[data-tour="tab-calendar"]',
    content: "Everything you've scheduled, laid out on a calendar.",
  },
  {
    target: '[data-tour="tab-api-keys"]',
    content:
      "On a paid plan, generate an API key here to automate scheduling through LazyRelay's REST API or MCP server.",
  },
  {
    target: '[data-tour="tab-settings"]',
    content: "Manage billing, storage, and your account here. Replay this tour anytime from the Account section.",
  },
];

export function ProductTour({ run, onFinish }: { run: boolean; onFinish: () => void }) {
  return (
    <Joyride
      steps={TOUR_STEPS}
      run={run}
      continuous
      scrollToFirstStep
      onEvent={(data: EventData) => {
        if (data.type === "tour:end") {
          onFinish();
        }
      }}
      options={{
        primaryColor: "#ff5630",
        zIndex: 10000,
        overlayClickAction: false,
      }}
    />
  );
}
