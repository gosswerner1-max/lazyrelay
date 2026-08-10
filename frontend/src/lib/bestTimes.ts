// General best-time-to-post guidance, per platform — NOT personalized to any
// one customer's actual audience. LazyRelay doesn't have post-level
// engagement data yet (see AnalyticsSummary — it's Proof-of-Publish/status
// data, not likes/shares/reach), so there's no real signal to personalize
// this against. These are widely-cited general social-media-marketing
// consensus windows (aggregated across major scheduling-tool research —
// Sprout Social, Hootsuite, Buffer publish similar general guidance) shown
// as a starting point, not a data-backed claim about this specific account.
// Revisit once real engagement metrics exist and this can become genuinely
// personalized per customer.

export interface BestTimeGuidance {
  windows: string;
  note: string;
}

export const BEST_TIME_GUIDANCE: Record<string, BestTimeGuidance> = {
  instagram: { windows: "Tue–Thu, 9–11am and 6–8pm", note: "Engagement tends to dip on Sundays." },
  facebook: { windows: "Tue–Thu, 9am–1pm", note: "Early afternoon on weekdays generally outperforms evenings." },
  tiktok: { windows: "Tue & Thu, 7–9pm; weekends midday", note: "Evening scrolling windows tend to perform best." },
  linkedin: { windows: "Tue–Thu, 8–10am", note: "Weekday work-hours windows outperform weekends by a wide margin." },
  threads: { windows: "Weekday mornings, 8–10am", note: "Mirrors X/Twitter-style real-time engagement patterns." },
  x: { windows: "Weekdays, 9am and 12–1pm", note: "Lunch-hour and morning-commute windows tend to spike." },
  pinterest: { windows: "Evenings and weekends, 8–11pm", note: "Saturday mornings are also a strong window." },
  youtube: { windows: "Weekday afternoons, 2–4pm", note: "Fri–Sun uploads often carry into weekend watch-time." },
  bluesky: { windows: "Weekday mornings, 8–10am", note: "Still-forming platform, treat this as a rough starting point." },
  mastodon: { windows: "Weekday mornings, 8–10am", note: "Federated timelines vary a lot by instance/community." },
  telegram: { windows: "Weekday evenings, 6–9pm", note: "Channel subscribers tend to check in after work hours." },
  discord: { windows: "Evenings, 6–10pm", note: "Community activity clusters around evenings and weekends." },
  tumblr: { windows: "Late evenings, 9pm–midnight", note: "Skews toward a night-owl audience." },
};

export const DEFAULT_BEST_TIME_GUIDANCE: BestTimeGuidance = {
  windows: "Weekday mornings, 8–10am",
  note: "No specific benchmark for this platform yet, using a general weekday-morning default.",
};

export function bestTimeFor(platform: string): BestTimeGuidance {
  return BEST_TIME_GUIDANCE[platform.toLowerCase()] ?? DEFAULT_BEST_TIME_GUIDANCE;
}
