import { useEffect, useId, useRef, type KeyboardEvent } from "react";

/** Shown every time the Pinterest tile's connect button is pressed, before
 *  the normal OAuth start (Dashboard.tsx's handleConnect) runs. Pinterest is
 *  strict with brand-new accounts and brand-new websites, and LazyRelay caps
 *  posting at 10 pins a day per account (backend/src/platformPostLimits.ts),
 *  so this tells a customer that up front instead of after a rejection.
 *  Nothing is persisted; it appears on every press. Built on the same
 *  .modal-overlay/.modal-card styling as the app's other modals, plus the
 *  dialog semantics those don't have: role, aria-modal, a label, focus moved
 *  in on open and handed back on close, Escape to cancel, and Tab kept inside. */
export function PinterestConnectModal({ onConnect, onCancel }: { onConnect: () => void; onCancel: () => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => opener?.focus();
  }, []);

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
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
          <h2 id={titleId}>Before you connect Pinterest</h2>
        </div>
        <ul className="modal-loss-list" style={{ marginTop: "16px" }}>
          <li>
            New Pinterest account? Warm it up by hand first. Post 1 pin a day for the first week, then 2, then 3, until it
            reaches 100+ monthly views (about 2 weeks). Then connect it.
          </li>
          <li>Promoting a brand-new website? Pinterest checks new websites closely. Start slowly and vary your captions.</li>
          <li>LazyRelay allows up to 10 pins a day per Pinterest account.</li>
          <li>
            If Pinterest blocks a link, that decision is Pinterest's. You can ask Pinterest to review it in its Help Center.
          </li>
        </ul>
        <div className="modal-actions">
          <button type="button" onClick={onConnect}>
            Connect Pinterest
          </button>
          <button type="button" className="btn-outline" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
