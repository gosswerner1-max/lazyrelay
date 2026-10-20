// Where a guided tour popover goes next to its target. Pure: the rectangle of the target, the size of the popover and the
// size of the viewport go in; the side, the clamped offsets and the arrow position come out. All numbers are viewport pixels.

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Side = "below" | "above" | "inside";

export interface Placement {
  side: Side;
  top: number;
  left: number;
  width: number;
  /** The tallest the popover may be here. It scrolls inside when its content is taller. */
  maxHeight: number;
  /** Distance of the arrow tip from the popover's left edge. Unused when side is "inside". */
  arrowLeft: number;
}

export interface PlacementOptions {
  gap?: number;
  margin?: number;
  arrowInset?: number;
  minHeight?: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

export function computePlacement(target: Rect, popover: Size, viewport: Size, options: PlacementOptions = {}): Placement {
  const { gap = 12, margin = 8, arrowInset = 16, minHeight = 96 } = options;
  const width = Math.min(popover.width, viewport.width - 2 * margin);
  const left = clamp(target.left + target.width / 2 - width / 2, margin, viewport.width - width - margin);
  const arrowLeft = clamp(target.left + target.width / 2 - left, arrowInset, width - arrowInset);

  const spaceBelow = viewport.height - (target.top + target.height) - gap - margin;
  const spaceAbove = target.top - gap - margin;

  let side: Side;
  if (popover.height <= spaceBelow) side = "below";
  else if (popover.height <= spaceAbove) side = "above";
  else if (Math.max(spaceBelow, spaceAbove) >= minHeight) side = spaceBelow >= spaceAbove ? "below" : "above";
  else side = "inside";

  if (side === "inside") return { side, top: margin, left, width, maxHeight: viewport.height - 2 * margin, arrowLeft };
  const space = side === "below" ? spaceBelow : spaceAbove;
  const maxHeight = Math.min(popover.height, space);
  const top = side === "below" ? target.top + target.height + gap : target.top - gap - maxHeight;
  return { side, top, left, width, maxHeight, arrowLeft };
}
