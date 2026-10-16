import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BYOK_DISCLAIMER_TEXT, BYOK_DISCLAIMER_TITLE } from "../lib/byokDisclaimer";
import "../styles/byok-disclaimer.css";

/** The notice that opens the moment a customer tries to connect their own X keys or their own Meta (WhatsApp) token,
 *  BEFORE anything is sent. Continue runs the connect, Cancel (the button, Escape or a click on the backdrop) does
 *  nothing and sends nothing. Same dialog behaviour as MastodonServerModal and PinterestConnectModal: labelled, modal,
 *  focus moved in and handed back to the button that opened it, Tab kept inside. It is rendered into document.body so a
 *  glass card around the button can never trap its fixed positioning. */
export function ByokDisclaimerModal({ onContinue, onCancel }: { onContinue: () => void; onCancel: () => void }) {
  const titleId = useId();
  const textId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => opener?.focus();
  }, []);

  // Escape cancels wherever focus happens to be (it is kept inside, but a click on the page text must not break this).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  function trapTab(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || active === dialogRef.current)) {
      e.preventDefault();
      first.focus();
    }
  }

  function onBackdrop(e: MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onCancel();
  }

  return createPortal(
    <div className="byok-disclaimer__overlay" onClick={onBackdrop} onKeyDown={trapTab}>
      <div ref={dialogRef} className="byok-disclaimer__card" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={textId} tabIndex={-1}>
        <h2 id={titleId} className="byok-disclaimer__title">
          {BYOK_DISCLAIMER_TITLE}
        </h2>
        <p id={textId} className="byok-disclaimer__text">
          {BYOK_DISCLAIMER_TEXT}
        </p>
        <div className="byok-disclaimer__actions">
          <button type="button" className="byok-disclaimer__continue" onClick={onContinue}>
            Continue
          </button>
          <button type="button" className="byok-disclaimer__cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** `ask(action)` opens the notice instead of running `action`; Continue runs it once, Cancel drops it. Render `modal`
 *  once next to the form. Every attempt asks again, nothing is remembered. */
export function useByokDisclaimer(): { ask: (action: () => void) => void; modal: ReactNode } {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const ask = useCallback((action: () => void) => setPending(() => action), []);
  const cancel = useCallback(() => setPending(null), []);
  const proceed = useCallback(() => {
    const action = pending;
    setPending(null);
    action?.();
  }, [pending]);
  return { ask, modal: pending ? <ByokDisclaimerModal onContinue={proceed} onCancel={cancel} /> : null };
}
