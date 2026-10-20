// Guided tour steps as data, and the one rule that makes a tour adapt to the page: a step whose target is not on the page, or
// whose onlyIf says no, is left out. Pure apart from reading the DOM it is handed. Nothing is stored.

import type { RefObject } from "react";

export interface TourStep {
  id: string;
  /** CSS selector of the target, looked up in the page. */
  selector?: string;
  /** Or a ref to the target. */
  ref?: RefObject<HTMLElement | null>;
  title: string;
  text: string;
  /** Return false to leave this step out. */
  onlyIf?: () => boolean;
}

export interface ResolvedStep extends TourStep {
  element: HTMLElement;
}

function findTarget(step: TourStep, root: ParentNode): HTMLElement | null {
  if (step.ref) return step.ref.current;
  return step.selector ? root.querySelector<HTMLElement>(step.selector) : null;
}

export function resolveTourSteps(steps: TourStep[], root: ParentNode = document): ResolvedStep[] {
  const out: ResolvedStep[] = [];
  for (const step of steps) {
    if (step.onlyIf && !step.onlyIf()) continue;
    const element = findTarget(step, root);
    if (element) out.push({ ...step, element });
  }
  return out;
}
