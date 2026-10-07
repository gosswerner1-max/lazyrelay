// The model call for the drafting step (replyDrafting.ts), kept apart so the rules can be tested without the
// Anthropic library. Same optional-integration pattern as commentTriage.ts and the caption tools: no
// ANTHROPIC_API_KEY, or a failed call, just means no draft this time. It never throws.

import { createAnthropicClient } from "./posthogClient.js";
import type { Generate } from "./replyDrafting.js";

// One place to change the model. Haiku is what comment triage and the caption tools already use; a reply the owner
// reviews is low stakes, and replyDrafting.validateModelReply checks every answer rather than trusting it.
export const REPLY_DRAFT_MODEL = "claude-haiku-4-5";
const TIMEOUT_MS = 20_000;

interface MessagesClient {
  messages: {
    create(body: { model: string; max_tokens: number; system: string; messages: { role: "user"; content: string }[] }): Promise<{ content: { type: string; text?: string }[] }>;
  };
}

/** Wraps a client (the real one, or a fake in tests) as the Generate function the drafting step takes. */
export function makeGenerate(client: MessagesClient): Generate {
  return async ({ system, user, maxTokens }) => {
    try {
      const message = await client.messages.create({ model: REPLY_DRAFT_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] });
      const block = message.content.find((b) => b.type === "text");
      return block && typeof block.text === "string" ? block.text : null;
    } catch (err) {
      console.error("[replyDraftingModel] call failed:", err instanceof Error ? err.message : err);
      return null;
    }
  };
}

/** The real generator, or null when no API key is configured. */
export function defaultGenerate(env: Record<string, string | undefined> = process.env): Generate | null {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return makeGenerate(createAnthropicClient(apiKey, TIMEOUT_MS) as unknown as MessagesClient);
}
