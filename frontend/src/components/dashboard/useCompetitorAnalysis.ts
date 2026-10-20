// The state behind one blueprint request: idle, running, done or a plain error. The request is cut off after
// ANALYZE_TIMEOUT_MS even if the service never answers, so the screen can never sit on a spinner.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CompetitorBlueprint } from "../../lib/competitorBlueprint";
import { ANALYZE_TIMEOUT_MS, CompetitorError, type CompetitorClient } from "../../lib/competitorMode";

export type AnalysisState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: CompetitorBlueprint }
  | { kind: "error"; message: string; code?: string };

function plainError(err: unknown): { message: string; code?: string } {
  if (err instanceof CompetitorError) return { message: err.message, code: err.code };
  console.error(err); // not one of ours: the raw error stays in the console, the customer gets the plain line
  return { message: new CompetitorError("unknown").message };
}

/** A paid run that lost its connection is tried once more with the SAME key, so the service can tell it is the same run. */
export const RETRY_DELAY_MS = 1000;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runOnce(client: CompetitorClient, input: string, signal: AbortSignal, key: string | undefined, stillCurrent: () => boolean) {
  const attempt = () => (key === undefined ? client.blueprint(input, signal) : client.blueprint(input, signal, key));
  try {
    return await attempt();
  } catch (err) {
    if (key === undefined || !(err instanceof CompetitorError) || err.code !== "network") throw err;
    await wait(RETRY_DELAY_MS);
    if (!stillCurrent() || signal.aborted) throw err;
    return attempt();
  }
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
    async (input: string, idempotencyKey?: string) => {
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
        const result = await runOnce(client, input, ctl.signal, idempotencyKey, () => current.current === id);
        if (current.current !== id) return;
        clearTimeout(timer.current);
        setState({ kind: "done", result });
      } catch (err) {
        if (current.current !== id) return; // cancelled or timed out already: that has its own answer
        clearTimeout(timer.current);
        setState({ kind: "error", ...plainError(err) });
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
