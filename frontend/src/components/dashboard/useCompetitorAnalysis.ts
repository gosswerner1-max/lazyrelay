// The state behind one competitor analysis: idle, running, done or a plain error. The request is cut off after
// ANALYZE_TIMEOUT_MS even if the service never answers, so the screen can never sit on a spinner.

import { useCallback, useEffect, useRef, useState } from "react";
import { ANALYZE_TIMEOUT_MS, CompetitorError, type CompetitorAnalysis, type CompetitorClient } from "../../lib/competitorMode";

export type AnalysisState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; analysis: CompetitorAnalysis }
  | { kind: "error"; message: string };

function plainMessage(err: unknown): string {
  if (err instanceof CompetitorError) return err.message;
  console.error(err); // not one of ours: the raw error stays in the console, the customer gets the plain line
  return new CompetitorError("unknown").message;
}

export function useCompetitorAnalysis(client: CompetitorClient) {
  const [state, setState] = useState<AnalysisState>({ kind: "idle" });
  const current = useRef(0); // which request may still change the screen
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stop = useCallback(() => {
    current.current += 1;
    clearTimeout(timer.current);
    controller.current?.abort();
    controller.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(
    async (input: string) => {
      stop();
      const id = current.current;
      const ctl = new AbortController();
      controller.current = ctl;
      setState({ kind: "running" });
      timer.current = setTimeout(() => {
        if (current.current !== id) return;
        stop();
        setState({ kind: "error", message: new CompetitorError("timeout").message });
      }, ANALYZE_TIMEOUT_MS);
      try {
        const analysis = await client.analyze(input, ctl.signal);
        if (current.current !== id) return;
        clearTimeout(timer.current);
        setState({ kind: "done", analysis });
      } catch (err) {
        if (current.current !== id) return; // cancelled or timed out already: that has its own answer
        clearTimeout(timer.current);
        setState({ kind: "error", message: plainMessage(err) });
      }
    },
    [client, stop],
  );

  const cancel = useCallback(() => {
    stop();
    setState({ kind: "idle" });
  }, [stop]);

  return { state, start, cancel };
}
