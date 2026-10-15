import type { ReactNode } from "react";
import { AnimatePresence, LazyMotion, m, useReducedMotion } from "motion/react";

// Spring enter/exit for menus and panels that open from a trigger (mobile nav menu, support widget).
//
// Apple's spring is damping ratio 0.8 + response 0.3s for sheets/drawers (apple-design rules, section 4). Motion's
// spring API takes bounce + duration: bounce = 1 - dampingRatio = 0.2, duration = response = 0.3. Enter and exit run
// the same path (the exit target is the initial state), only transform (scale) and opacity animate, and the panel
// scales from `origin`, the corner where its trigger sits. Springs re-target from the live value and velocity, so
// toggling mid-flight reverses cleanly. Reduced motion: a 200ms opacity cross-fade, no transform at all.
//
// The animation engine is fetched after load (async LazyMotion features), keeping it out of the entry chunk; a panel
// opened before it arrives simply appears without the spring.
const SPRING = { type: "spring", duration: 0.3, bounce: 0.2 } as const;
const FADE = { duration: 0.2, ease: "linear" } as const;
const HIDDEN = { opacity: 0, scale: 0.92 };
const SHOWN = { opacity: 1, scale: 1 };

const loadFeatures = () => import("../lib/motionFeatures").then((mod) => mod.default);

const TAGS = { div: m.div, nav: m.nav } as const;

export interface SpringPanelProps {
  open: boolean;
  /** CSS transform-origin: the corner of the trigger this panel opens from, e.g. "top right". */
  origin: string;
  as?: keyof typeof TAGS;
  id?: string;
  className?: string;
  role?: string;
  "aria-label"?: string;
  children: ReactNode;
}

export function SpringPanel({ open, origin, as = "div", children, ...rest }: SpringPanelProps) {
  const reduceMotion = useReducedMotion();
  const Tag = TAGS[as];
  const hidden = reduceMotion ? { opacity: 0 } : HIDDEN;
  const shown = reduceMotion ? { opacity: 1 } : SHOWN;
  const transition = reduceMotion ? FADE : SPRING;

  return (
    <LazyMotion features={loadFeatures}>
      <AnimatePresence>
        {open && (
          <Tag
            {...rest}
            style={{ transformOrigin: origin }}
            initial={hidden}
            animate={{ ...shown, transition }}
            exit={{ ...hidden, transition }}
          >
            {children}
          </Tag>
        )}
      </AnimatePresence>
    </LazyMotion>
  );
}
