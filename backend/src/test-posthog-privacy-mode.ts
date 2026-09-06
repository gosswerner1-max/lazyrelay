import "dotenv/config";
import { getPostHogClient, createAnthropicClient } from "./posthogClient.js";

// Real, live verification for the 2026-09-06 posthogClient.ts privacy fix.
// Goes through the REAL production code path (createAnthropicClient, the
// exact function every Anthropic-backed feature in this codebase calls) --
// not a hand-reconstructed wrapper -- with a unique marker string in a real
// prompt, then inspects the actual event object @posthog/ai builds for
// PostHog to prove the marker text never appears in it. The real PostHog
// client's own .capture() is intercepted (not called through to PostHog's
// servers) specifically so this test doesn't send fake analytics events to
// the real project.

let failures = 0;
function report(label: string, pass: boolean, detail?: string) {
  console.log(`${pass ? "PASS" : "FAIL"} — ${label}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures++;
}

async function main() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY must be set to run this test");

  const posthog = getPostHogClient();
  if (!posthog) throw new Error("POSTHOG_API_KEY must be set to run this test");

  const capturedEvents: Record<string, unknown>[] = [];
  posthog.capture = ((props: Record<string, unknown>) => {
    capturedEvents.push(props);
  }) as typeof posthog.capture;

  const client = createAnthropicClient(anthropicKey, 20_000);

  const marker = `SENTINEL-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 30,
    messages: [{ role: "user", content: `Reply with exactly one word: "acknowledged". Do not mention this marker: ${marker}` }],
  });

  const genEvent = capturedEvents.find((e) => e.event === "$ai_generation");
  report("A real $ai_generation event was actually captured for this call", !!genEvent);

  const eventJson = JSON.stringify(genEvent ?? {});
  report("The marker text (from the real prompt) does NOT appear anywhere in the captured event", !eventJson.includes(marker));

  const props = (genEvent?.properties ?? {}) as Record<string, unknown>;
  report("$ai_input is redacted to null, not the real prompt", props.$ai_input === null, JSON.stringify(props.$ai_input));
  report(
    "$ai_output_choices is redacted to null, not the real completion",
    props.$ai_output_choices === null,
    JSON.stringify(props.$ai_output_choices),
  );
  report(
    "Cost/latency/token metrics are still present — this fix redacts content, not observability",
    typeof props.$ai_input_tokens === "number" && typeof props.$ai_output_tokens === "number" && typeof props.$ai_latency === "number",
    `input_tokens=${props.$ai_input_tokens} output_tokens=${props.$ai_output_tokens} latency=${props.$ai_latency}`,
  );

  // Sanity check the call itself actually happened for real (not a mocked
  // response) -- confirms this test exercised the real network path.
  const realReply = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
  report("The real Anthropic call actually returned a real response", realReply.length > 0, `"${realReply}"`);

  // posthog-node runs a background flush timer for the life of the
  // process -- shutdown() tries to close it cleanly before exit. On
  // Windows this can still print a benign libuv assertion
  // ("UV_HANDLE_CLOSING", src\win\async.c) after process.exit() fires --
  // a known teardown-timing quirk, not a test failure; it happens strictly
  // after all assertions above have already run and printed.
  await posthog.shutdown();

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("PostHog privacy-mode test crashed:", err);
  process.exit(1);
});
