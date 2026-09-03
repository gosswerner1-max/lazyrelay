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

/** Call once at app startup (see main.tsx). Loads the library and starts
 *  it in an opted-out state -- matches the existing Google Consent Mode
 *  pattern in CookieConsent.tsx, which also defaults every non-essential
 *  category to denied until the visitor makes an explicit choice. Capture
 *  only actually starts once setPostHogConsent(true) is called. */
export function initPostHog(): void {
  if (initialized) return;
  initialized = true;
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    person_profiles: "identified_only",
    opt_out_capturing_by_default: true,
    capture_pageview: true,
    autocapture: true,
  });
}

/** Wired into CookieConsent.tsx's applyConsent()/restoreStoredConsent() so
 *  PostHog capture follows the same opt-in analytics choice as Google
 *  Consent Mode, rather than tracking before the visitor has chosen. */
export function setPostHogConsent(granted: boolean): void {
  if (!initialized) return;
  if (granted) posthog.opt_in_capturing();
  else posthog.opt_out_capturing();
}

export { posthog };
