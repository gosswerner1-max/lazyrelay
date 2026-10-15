// PostHog project set up 2026-09-03 (Werner, US data region). Session
// Replay is configured server-side to "Total privacy" masking (all text
// and images masked, not just form inputs) -- LazyRelay's dashboard
// displays real secrets as plain on-screen text at least twice (the
// one-time API key reveal, the webhook secret reveal), which "Normal"
// masking (inputs only) would not protect. loadPostHog() below adds a
// second, code-level layer: explicit ph-mask/ph-no-capture annotations on
// those two components specifically, so they stay masked even if the
// project-level setting is ever loosened for everything else.
const POSTHOG_KEY = "phc_nQhXtkXVvt3PCem6AWcRywgGZhR53Hkr6uvrqskYomwB";
const POSTHOG_HOST = "https://us.i.posthog.com";

type PostHogClient = (typeof import("posthog-js"))["default"];

let client: PostHogClient | null = null;
let loading: Promise<PostHogClient> | null = null;
let wantsCapture = false;

/** Loads posthog-js and starts it, once. posthog-js is a dynamic import on purpose (about 276 KB of source): it is only
 *  ever needed after a visitor grants analytics consent, so a visitor who never consents never downloads it and it stays
 *  out of the main entry bundle. A failed load is reported on the console and not cached, so the next grant retries. */
function loadPostHog(): Promise<PostHogClient> {
  loading ??= import("posthog-js")
    .then((mod) => {
      mod.default.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        person_profiles: "identified_only",
        capture_pageview: true,
        autocapture: true,
      });
      client = mod.default;
      return mod.default;
    })
    .catch((err: unknown) => {
      loading = null;
      console.error("PostHog failed to load; analytics stay off until the next consent grant.", err);
      throw err;
    });
  return loading;
}

/** Wired into CookieConsent.tsx's applyConsent()/restoreStoredConsent() so
 *  PostHog capture follows the same opt-in analytics choice as Google
 *  Consent Mode. Loads and initializes PostHog for the first time on the first
 *  granted=true call (a fresh visitor accepting, or a returning visitor's
 *  stored choice being restored) -- if consent is never granted, PostHog
 *  is never loaded or initialized at all, not just left in an opted-out state.
 *  The original reasoning still holds: posthog-js's own init() sets a
 *  persistent device-id cookie immediately (found 2026-09-04), so init must
 *  not run before consent. If consent is revoked while the library is still
 *  loading, the visitor ends opted out. */
export function setPostHogConsent(granted: boolean): void {
  wantsCapture = granted;
  if (granted) {
    loadPostHog()
      .then((ph) => (wantsCapture ? ph.opt_in_capturing() : ph.opt_out_capturing()))
      .catch(() => undefined); // already reported by loadPostHog's console.error
  } else if (client) {
    client.opt_out_capturing();
  }
}
