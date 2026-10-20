// The notice that opens before a competitor link is sent anywhere. The consent box must be ticked before Analyze this link
// works; Cancel, Escape and a click on the backdrop send nothing. It grows out of the Analyze button and leaves the same way
// (only transform and opacity move), can be reopened while it is still leaving, and gives focus back to the button.

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { CONSENT_TEXT } from "../../lib/competitorMode";

const EXIT_MS = 160; // keep in step with the transition in competitor-mode.css

export interface DialogOrigin {
  x: number;
  y: number;
}

interface Props {
  open: boolean;
  link: string;
  origin: DialogOrigin | null;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** Keeps Tab inside the dialog, both ways round. */
function trapTab(e: KeyboardEvent<HTMLDivElement>, dialog: HTMLElement | null) {
  if (e.key !== "Tab") return;
  const items = dialog?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])");
  if (!items || items.length === 0) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === dialog)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || active === dialog)) {
    e.preventDefault();
    first.focus();
  }
}

/** Mounting, the enter and leave states, focus in and back out, the grow-from-the-button origin, and Escape. */
function useDialogLifecycle({ open, origin, restoreFocusTo, onCancel }: Pick<Props, "open" | "origin" | "restoreFocusTo" | "onCancel">) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const [agreed, setAgreed] = useState(false);

  // Reopening while it is still leaving cancels the removal, so the motion turns around from where it is.
  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    setAgreed(false); // every open asks again
    const gone = setTimeout(() => setMounted(false), reducedMotion() ? 0 : EXIT_MS);
    return () => clearTimeout(gone);
  }, [open]);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      dialogRef.current?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      restoreFocusTo.current?.focus();
    }
  }, [open, mounted, restoreFocusTo]);

  // The card grows from the Analyze button: its transform origin is that button, measured against the card.
  useLayoutEffect(() => {
    const card = dialogRef.current;
    if (!mounted || !card || !origin) return;
    const box = card.getBoundingClientRect();
    card.style.transformOrigin = `${Math.round(origin.x - box.left)}px ${Math.round(origin.y - box.top)}px`;
  }, [mounted, origin]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCancel();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onCancel]);

  return { dialogRef, mounted, shown, agreed, setAgreed };
}

export function CompetitorConsentDialog({ open, link, origin, restoreFocusTo, onConfirm, onCancel }: Props) {
  const titleId = useId();
  const textId = useId();
  const { dialogRef, mounted, shown, agreed, setAgreed } = useDialogLifecycle({ open, origin, restoreFocusTo, onCancel });

  function onBackdrop(e: MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onCancel();
  }

  if (!mounted) return null;
  return (
    <div className="cs-modal" data-state={shown && open ? "open" : "closed"} onClick={onBackdrop} onKeyDown={(e) => trapTab(e, dialogRef.current)}>
      <div ref={dialogRef} className="cs-modal__card" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={textId} tabIndex={-1}>
        <h3 id={titleId} className="cs-modal__title">
          Before you analyze
        </h3>
        <p id={textId} className="cs-note">
          We will read this public link and write a draft post from it. Read the draft and fix anything that is wrong before you use it.
        </p>
        <p className="cs-code">{link}</p>
        <label className="cs-consent">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>{CONSENT_TEXT}</span>
        </label>
        <div className="cs-actions">
          <button type="button" className="cs-btn cs-btn--primary" disabled={!agreed} onClick={onConfirm}>
            Analyze this link
          </button>
          <button type="button" className="cs-btn cs-btn--secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
