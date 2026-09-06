import { PostHog } from "posthog-node";
import AnthropicOriginal from "@anthropic-ai/sdk";
import { Anthropic as PostHogAnthropic } from "@posthog/ai/anthropic";

// Shared PostHog Node client for LLM observability on Anthropic calls,
// added 2026-09-03. Same optional-integration fall-through pattern as
// every Anthropic-backed feature here: a missing key degrades this one
// thing (no cost/latency/quality tracking) rather than throwing anywhere.
// One client for the life of the process -- posthog-node batches and
// flushes in the background on its own, so callers never need to flush
// or shut it down per-request.
let client: PostHog | null | undefined;

export function getPostHogClient(): PostHog | null {
  if (client !== undefined) return client;
  const apiKey = process.env.POSTHOG_API_KEY;
  client = apiKey ? new PostHog(apiKey, { host: "https://us.i.posthog.com" }) : null;
  return client;
}

/** Every Anthropic client in this codebase should be created through this
 *  helper instead of `new Anthropic(...)` directly, added 2026-09-03 so
 *  every caption-generation/comment-triage call gets cost/latency/quality
 *  tracking in PostHog's AI observability for free. Falls back to a plain
 *  Anthropic client with identical behavior when POSTHOG_API_KEY is unset
 *  -- @posthog/ai's wrapper type requires a real PostHog instance, so this
 *  branch (not a null posthog option) is what keeps every existing
 *  Anthropic-backed feature working unmodified on a deploy without the key.
 *
 *  Forces `posthogPrivacyMode: true` on every single call made through the
 *  returned client -- real gap found and fixed 2026-09-06. Without it,
 *  @posthog/ai's wrapper sends the FULL prompt and completion text of every
 *  call to PostHog by default (the per-call flag defaults to false, and
 *  none of this codebase's 6 call sites, as of the fix, ever set it). That
 *  meant full support-chat transcripts, real third-party commenters' names
 *  and message text (people who never signed up for LazyRelay -- they just
 *  commented on a customer's post), and customer post content all reached
 *  PostHog, ungated by the cookie-consent banner (frontend-only; this
 *  client is backend-to-backend) and undisclosed in the Privacy
 *  Policy/DPA (which describe PostHog's role as analytics/session-
 *  replay/error-tracking, never AI-content capture).
 *
 *  Fixed HERE, once, rather than by adding the flag at each of the 6 call
 *  sites, so a 7th call site written later can't forget it -- same
 *  "consolidate the fix, don't scatter it" approach as streamUpload.ts's
 *  shared SSRF-safe fetch helper. Deliberately uses the DOCUMENTED per-call
 *  `posthogPrivacyMode` param (which @posthog/ai's own extractPosthogParams
 *  maps to its internal `privacyMode`), not posthog-node's own client-level
 *  `privacyMode` constructor option -- confirmed live that option is
 *  currently dead code in this dependency version (nothing in posthog-node
 *  or posthog-core reads it), so relying on it alone would have silently
 *  redacted nothing. Verified end-to-end with a real Anthropic call and a
 *  real (intercepted, not sent) PostHog event: test-posthog-privacy-mode.ts.
 *  Cost/latency/token/model metrics are unaffected -- only input/output
 *  text is redacted. */
export function createAnthropicClient(apiKey: string, timeout: number): AnthropicOriginal {
  const posthog = getPostHogClient();
  if (!posthog) return new AnthropicOriginal({ apiKey, timeout });

  // @posthog/ai bundles its own copy of @anthropic-ai/sdk, so its
  // PostHogAnthropic (which only overrides .messages) is structurally
  // compatible with -- but not nominally the same class as -- the plain
  // Anthropic type from our own node_modules. Safe to cast, not to widen
  // the return type to `any`: every call site only ever calls
  // `.messages.create(...)` or checks `Anthropic.APIConnectionTimeoutError`
  // via the static import, never anything from the mismatched private field.
  const wrapped = new PostHogAnthropic({ apiKey, timeout, posthog }) as unknown as AnthropicOriginal;
  const originalCreate = wrapped.messages.create.bind(wrapped.messages);
  wrapped.messages.create = ((body: Record<string, unknown>, options?: unknown) =>
    originalCreate({ ...body, posthogPrivacyMode: true } as never, options as never)) as unknown as typeof wrapped.messages.create;
  return wrapped;
}
