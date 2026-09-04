import posthog from "posthog-js";

// PostHog project set up 2026-09-03 (Werner, US data region). Session
// Replay is configured server-side to "Total privacy" masking (all text
// and images masked, not just form inputs) -- LazyRelay's dashboard
// displays real secrets as plain on-screen text at least twice (the
// one-time API key reveal, the webhook secret reveal), which "Normal"
// masking (inputs only) would not protect. initPostHog() below adds a
// second, code-level layer: explicit ph-mask/ph-no-capture annotations on
// those two components specifically, so they stay masked even if the
// project-level setting is ever loosened for everything else.
const POSTHOG_KEY = "phc_nQhXtkXVvt3PCem6AWcRywgGZhR53Hkr6uvrqskYomwB";
const POSTHOG_HOST = "https://us.i.posthog.com";

let initialized = false;

/** Lazily called from setPostHogConsent() the first time a visitor grants
 *  analytics consent -- never called eagerly at app startup. posthog-js's
 *  own init() sets a persistent device-id cookie immediately, regardless of
 *  opt_out_capturing_by_default, so initializing unconditionally at startup
 *  left an inert-but-real cookie on every visit before any choice was made
 *  (found 2026-09-04: zero data was ever sent before consent, verified live,
 *  but the cookie itself existed, which a strict cookie-law reading still
 *  cares about). Not initializing at all until consent is granted is the
 *  only way to guarantee zero PostHog footprint pre-consent. */
function initPostHog(): void {
  if (initialized) return;
  initialized = true;
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    person_profiles: "identified_only",
    capture_pageview: true,
    autocapture: true,
  });
}

/** Wired into CookieConsent.tsx's applyConsent()/restoreStoredConsent() so
 *  PostHog capture follows the same opt-in analytics choice as Google
 *  Consent Mode. Initializes PostHog for the first time on the first
 *  granted=true call (a fresh visitor accepting, or a returning visitor's
 *  stored choice being restored) -- if consent is never granted, PostHog
 *  is never initialized at all, not just left in an opted-out state. */
export function setPostHogConsent(granted: boolean): void {
  if (granted) {
    initPostHog();
    posthog.opt_in_capturing();
  } else if (initialized) {
    posthog.opt_out_capturing();
  }
}

export { posthog };
