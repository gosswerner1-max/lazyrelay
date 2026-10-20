// A small, reusable guided tour. A button opens a non-modal popover that walks through steps given as data (see
// lib/guidedTour.ts); a step whose target is not on the page is skipped. The popover sits next to the target on the side that
// has room (lib/tourPlacement.ts), a ring marks the target, Escape closes, and focus goes into the popover and back to the
// button. It opens nothing else on the page and stores nothing. Styles: styles/guided-tour.css.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { resolveTourSteps, type ResolvedStep, type TourStep } from "../../lib/guidedTour";
import { computePlacement, type Placement } from "../../lib/tourPlacement";
import "../../styles/guided-tour.css";

const RING_PAD = 4;

interface Props {
  steps: TourStep[];
  label?: string;
  /** Classes for the trigger button, so it matches the buttons around it. */
  buttonClassName?: string;
}

interface Geometry {
  place: Placement;
  rect: DOMRect;
}

function BulbIcon() {
  return (
    <svg className="guided-tour__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M9 18h6" />
      <path d="M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />
    </svg>
  );
}

/** Measures the target and the popover, and keeps both in step with scrolling and resizing. */
function useTourGeometry(step: ResolvedStep, popRef: RefObject<HTMLDivElement | null>, contentRef: RefObject<HTMLDivElement | null>) {
  const [geo, setGeo] = useState<Geometry | null>(null);
  const measure = useCallback(() => {
    const pop = popRef.current;
    const content = contentRef.current;
    if (!pop || !content) return;
    const rect = step.element.getBoundingClientRect();
    // The content box is never clamped, so its height is the natural height even while the popover scrolls.
    const height = content.offsetHeight + (pop.offsetHeight - pop.clientHeight);
    const place = computePlacement(rect, { width: pop.offsetWidth, height }, { width: window.innerWidth, height: window.innerHeight });
    setGeo({ place, rect });
  }, [step, popRef, contentRef]);

  useLayoutEffect(() => {
    if (typeof step.element.scrollIntoView === "function") step.element.scrollIntoView({ block: "center", inline: "nearest" });
    measure();
  }, [step, measure]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(content);
    return () => observer.disconnect();
  }, [measure, contentRef]);

  useEffect(() => {
    let frame = 0;
    const again = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener("scroll", again, true);
    window.addEventListener("resize", again);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", again, true);
      window.removeEventListener("resize", again);
    };
  }, [measure]);

  return geo;
}

interface PopoverProps {
  steps: ResolvedStep[];
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
}

function TourPopover({ steps, index, onIndex, onClose }: PopoverProps) {
  const step = steps[index]!;
  const popRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const textId = useId();
  const geo = useTourGeometry(step, popRef, contentRef);
  const [shown, setShown] = useState(false);
  const last = index === steps.length - 1;

  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Focus goes into the popover when it opens, and again if a click removed the focused button.
  useEffect(() => {
    const pop = popRef.current;
    if (pop && !pop.contains(document.activeElement)) pop.focus();
  }, [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const place = geo?.place;
  const popStyle = place ? { top: place.top, left: place.left, width: place.width } : undefined;
  const rect = geo?.rect;
  const ringStyle = rect ? { transform: `translate(${rect.left - RING_PAD}px, ${rect.top - RING_PAD}px)`, width: rect.width + 2 * RING_PAD, height: rect.height + 2 * RING_PAD } : undefined;

  return (
    <>
      <div className="guided-tour__ring" aria-hidden="true" data-ready={rect ? "true" : "false"} style={ringStyle} />
      <div
        ref={popRef}
        className="guided-tour"
        role="dialog"
        aria-labelledby={titleId}
        aria-describedby={textId}
        tabIndex={-1}
        data-side={place?.side ?? "below"}
        data-state={shown && place ? "open" : "closed"}
        style={popStyle}
      >
        <span className="guided-tour__arrow" aria-hidden="true" style={place ? { left: place.arrowLeft } : undefined} />
        <div className="guided-tour__scroll" style={place ? { maxHeight: Math.max(0, place.maxHeight - 2) } : undefined}>
          <div ref={contentRef} className="guided-tour__content">
            <p className="guided-tour__count">{`Step ${index + 1} of ${steps.length}`}</p>
            <h3 className="guided-tour__title" id={titleId}>
              {step.title}
            </h3>
            <p className="guided-tour__text" id={textId}>
              {step.text}
            </p>
            <div className="guided-tour__actions">
              <button type="button" className="guided-tour__btn guided-tour__btn--secondary" disabled={index === 0} onClick={() => onIndex(index - 1)}>
                Back
              </button>
              {last ? (
                <button type="button" className="guided-tour__btn guided-tour__btn--primary" onClick={onClose}>
                  Done
                </button>
              ) : (
                <button type="button" className="guided-tour__btn guided-tour__btn--primary" onClick={() => onIndex(index + 1)}>
                  Next
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export function GuidedTour({ steps, label = "Help me set up", buttonClassName = "" }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [active, setActive] = useState<ResolvedStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const [host, setHost] = useState<HTMLElement | null>(null);

  const close = useCallback(() => {
    setActive(null);
    triggerRef.current?.focus();
  }, []);

  function start() {
    const resolved = resolveTourSteps(steps);
    if (resolved.length === 0) return;
    setIndex(0);
    setHost(triggerRef.current?.closest<HTMLElement>(".byok-panels") ?? document.body);
    setActive(resolved);
  }

  return (
    <>
      <button ref={triggerRef} type="button" className={`guided-tour__trigger ${buttonClassName}`.trim()} onClick={start}>
        <BulbIcon />
        {label}
      </button>
      {active && host && createPortal(<TourPopover steps={active} index={index} onIndex={setIndex} onClose={close} />, host)}
    </>
  );
}
