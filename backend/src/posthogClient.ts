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
 *  Anthropic-backed feature working unmodified on a deploy without the key. */
export function createAnthropicClient(apiKey: string, timeout: number): AnthropicOriginal {
  const posthog = getPostHogClient();
  // @posthog/ai bundles its own copy of @anthropic-ai/sdk, so its
  // PostHogAnthropic (which only overrides .messages) is structurally
  // compatible with -- but not nominally the same class as -- the plain
  // Anthropic type from our own node_modules. Safe to cast, not to widen
  // the return type to `any`: every call site only ever calls
  // `.messages.create(...)` or checks `Anthropic.APIConnectionTimeoutError`
  // via the static import, never anything from the mismatched private field.
  return posthog
    ? (new PostHogAnthropic({ apiKey, timeout, posthog }) as unknown as AnthropicOriginal)
    : new AnthropicOriginal({ apiKey, timeout });
}
