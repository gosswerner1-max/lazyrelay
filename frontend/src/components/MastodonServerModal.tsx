import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

/** Shown every time the Mastodon tile is pressed, before the normal connect
 *  starts (useDashboardState's handleConnect). Mastodon is many independent
 *  servers, so LazyRelay has to know which one the account is on. One question,
 *  one step; an empty box means mastodon.social, the original default. Nothing
 *  is remembered: it is asked on every press. The address is checked properly
 *  by the backend, which answers in plain words if it is not usable. Built on
 *  the same .modal-overlay/.modal-card styling as PinterestConnectModal, with the
 *  same dialog behaviour: labelled, focus moved in and handed back, Escape to
 *  cancel, Tab kept inside. */
export function MastodonServerModal({ onConnect, onCancel }: { onConnect: (instance: string) => Promise<string | null> | string | null | void; onCancel: () => void }) {
  const titleId = useId();
  const inputId = useId();
  const hintId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [instance, setInstance] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => opener?.focus();
  }, []);

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("input:not([disabled]), button:not([disabled])");
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // The dialog stays open if the connect could not start: the reason shows inside it.
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const problem = await onConnect(instance.trim());
      if (problem) setError(problem);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the connection. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onCancel} onKeyDown={handleKeyDown}>
      <div
        ref={dialogRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ outline: "none" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Connect Mastodon</h2>
        </div>
        <form onSubmit={handleSubmit} style={{ marginTop: "16px" }}>
          <label htmlFor={inputId} style={{ display: "block", marginBottom: "6px" }}>
            Mastodon server
          </label>
          <input
            id={inputId}
            ref={inputRef}
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="mastodon.social"
            value={instance}
            onChange={(e) => setInstance(e.target.value)}
            aria-describedby={hintId}
            style={{ width: "100%", boxSizing: "border-box" }}
          />
          <p id={hintId} className="field-hint" style={{ margin: "8px 0 0" }}>
            The address of the server your account is on, for example hachyderm.io
          </p>
          {error && (
            <p role="alert" className="error" style={{ margin: "8px 0 0" }}>
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button type="submit" disabled={busy}>
              {busy ? "Connecting..." : "Connect Mastodon"}
            </button>
            <button type="button" className="btn-outline" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
