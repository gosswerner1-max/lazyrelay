// DEV ONLY. A fake in-memory competitor client for the front door preview. Nothing is sent anywhere.

import type { CompetitorBlueprint } from "../lib/competitorBlueprint";
import type { CompetitorClient } from "../lib/competitorMode";

export const FAKE_DELAY_MS = 1500;

const sample = (sourceUrl: string): CompetitorBlueprint => ({
  kind: "page",
  sourceUrl,
  title: "Sample competitor page",
  blueprint: {
    hook: { type: "statistic", note: "It opens with a number about hours lost to manual posting." },
    sections: [
      { order: 1, role: "Problem", summary: "Names the pain in one short paragraph." },
      { order: 2, role: "How it works", summary: "Three steps with one line each." },
      { order: 3, role: "Plans", summary: "Lists two plans side by side." },
      { order: 4, role: "Questions", summary: "Answers the five most common questions." },
    ],
    cta: { placement: "multiple", style: "One button, repeated", count: 3 },
    adjustments: ["Open with a number of your own.", "Move your plans higher on the page.", "Repeat the button after the questions."],
  },
  creditsUsed: 10,
});

/** Answers with a sample blueprint after a short wait. Stops quietly when the request is cancelled. */
export const fakeClient: CompetitorClient = {
  blueprint(input, signal) {
    return new Promise<CompetitorBlueprint>((resolve, reject) => {
      const timer = setTimeout(() => resolve(sample(input)), FAKE_DELAY_MS);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("cancelled", "AbortError"));
      });
    });
  },
};
