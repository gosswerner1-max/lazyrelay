import { useState } from "react";

export function CodeBlock({ code }: { code: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setStatus("copied");
    } catch {
      // navigator.clipboard.writeText can genuinely reject (permission
      // denied, an insecure context, the document losing focus right
      // before the click registers) — without this catch the button did
      // nothing at all on failure, no error, no fallback, just silence.
      setStatus("failed");
    } finally {
      setTimeout(() => setStatus("idle"), 2000);
    }
  }

  return (
    <pre className="api-code-block">
      <button type="button" className={`api-code-copy${status === "failed" ? " api-code-copy-failed" : ""}`} onClick={handleCopy}>
        {status === "copied" ? "Copied!" : status === "failed" ? "Couldn't copy — select manually" : "Copy"}
      </button>
      <code>{code}</code>
    </pre>
  );
}
