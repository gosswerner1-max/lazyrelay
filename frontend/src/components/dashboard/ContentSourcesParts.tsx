// Small pieces the Content Sources tab shares: a status or error line, and the copy button used by the proof steps.

import { useEffect, useRef, useState } from "react";
import type { Msg } from "./useContentSources";

/** A message line. An error is announced at once (role alert); anything else politely (role status). */
export function Message({ msg, onOpenPlan }: { msg: Msg | null; onOpenPlan?: () => void }) {
  if (!msg) return null;
  return (
    <p className={`cs-result cs-result--${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"}>
      {msg.text}
      {msg.code === "plan_limit" && onOpenPlan && (
        <>
          {" "}
          <button type="button" className="cs-btn cs-btn--link" onClick={onOpenPlan}>
            See plans
          </button>
        </>
      )}
    </p>
  );
}

type CopyState = "idle" | "copied" | "failed";
const COPIED_FOR_MS = 3000;

/** Copies the exact text it is given. It says so when it worked, and says so (in plain words) when the browser refused. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch (err) {
      console.error(err); // the raw reason stays in the console; the customer gets the plain line
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), COPIED_FOR_MS);
  }

  return (
    <span className="cs-copy">
      <button type="button" className="cs-btn cs-btn--secondary" onClick={() => void copy()}>
        {label}
      </button>
      <span className="cs-copy__note" role="status">
        {state === "copied" ? "Copied" : state === "failed" ? "Could not copy. Select the text and copy it yourself." : ""}
      </span>
    </span>
  );
}
