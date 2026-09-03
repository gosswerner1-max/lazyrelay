import { Joyride, type EventData } from "react-joyride";

// react-joyride's own default for every step is closeButtonAction: "close",
// which just advances to the next step rather than ending the tour -- the
// tour never reaches STATUS.FINISHED/SKIPPED from a single ✕ click, so
// onEvent's "tour:end" never fires and the tour never gets marked seen
// (found 2026-08-30, root-caused 2026-09-03: the close button silently
// advancing one step, not a bug in onEvent's handling). "skip" is the
// correct action for a "close and don't show this again" button.
const TOUR_STEPS = [
  {
    target: "body",
    placement: "center" as const,
    disableBeacon: true,
    closeButtonAction: "skip" as const,
    content: "Welcome to LazyRelay. Here's where everything lives, in under a minute.",
  },
  {
    target: '[data-tour="tab-social-platforms"]',
    closeButtonAction: "skip" as const,
    content:
      "Connect your accounts here. Facebook, Instagram, TikTok, Pinterest, YouTube, LinkedIn, Threads, Mastodon, Bluesky, Telegram, Discord, and Tumblr, all in one place.",
  },
  {
    target: '[data-tour="tab-posts"]',
    closeButtonAction: "skip" as const,
    content:
      "Schedule a post here. Once it's due, LazyRelay's Proof-of-Publish independently checks that the post actually went live, not just that the platform's API accepted the request.",
  },
  {
    target: '[data-tour="tab-calendar"]',
    closeButtonAction: "skip" as const,
    content: "Everything you've scheduled, laid out on a calendar.",
  },
  {
    target: '[data-tour="tab-api-keys"]',
    closeButtonAction: "skip" as const,
    content:
      "On a paid plan, generate an API key here to automate scheduling through LazyRelay's REST API or MCP server.",
  },
  {
    target: '[data-tour="tab-settings"]',
    closeButtonAction: "skip" as const,
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
