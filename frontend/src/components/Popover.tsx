import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface PopoverProps {
  /** The clicked element's bounding rect at the moment it was opened —
   *  the popover anchors near this, not to a live-tracked element, since
   *  every caller here opens from a one-off click rather than something
   *  that stays mounted and could move (an event chip inside a day cell
   *  that might re-render, a day cell itself). */
  anchorRect: DOMRect;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

/** A floating panel anchored near a click point — portal-rendered so it
 *  isn't clipped by the calendar grid's own overflow, closes on outside
 *  click or Escape, and flips to the opposite side of its anchor if it
 *  wouldn't otherwise fit in the viewport. Replaces the Calendar tab's old
 *  below-grid `.calendar-day-detail` panel (2026-08-30) with something
 *  closer to Google Calendar's own event/day popovers. */
export function Popover({ anchorRect, onClose, children, className }: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const margin = 8;
    const rect = el.getBoundingClientRect();
    let left = anchorRect.left;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    let top = anchorRect.bottom + margin;
    if (top + rect.height > window.innerHeight - margin) {
      // Doesn't fit below the anchor — flip above it instead, same pattern
      // real calendar apps use for a click near the bottom of the screen.
      const above = anchorRect.top - rect.height - margin;
      top = above >= margin ? above : margin;
    }
    setStyle({ position: "fixed", top, left, visibility: "visible" });
    // Only recompute when the anchor itself changes — the panel's own
    // content changing size (e.g. expanding a section inside it) doesn't
    // need to re-run this, it just grows from wherever it already is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorRect]);

  return createPortal(
    <div ref={panelRef} className={`popover-panel${className ? ` ${className}` : ""}`} style={style} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}
