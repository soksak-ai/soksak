// Where the rail stands is on the space's plane (state/panePlane: the rail is a card). What is
// the workspace's is how it behaves when focus moves.
//
// FLOW stands the rail beside the focused pane; PIN leaves it where it is. A pinned station used to
// be a number stored here and snapped to a clean line at every change; the card's own slot is that
// line now, and a slot cannot be crossed (split-pane R3), so there is nothing to validate.

export type RailPlacement = { mode: "flow" } | { mode: "pin" };

export const DEFAULT_RAIL_PLACEMENT: RailPlacement = { mode: "flow" };

export interface InsetRailRect {
  leftInsetPx: number;
  widthPx: number;
}

/** Visible rail frame inside its slot; the slot itself never changes. */
export function insetRailRect(allocatedWidthPx: number, paneInsetPx: number): InsetRailRect {
  const width = Math.max(0, Number.isFinite(allocatedWidthPx) ? allocatedWidthPx : 0);
  const inset = Math.min(
    width / 2,
    Math.max(0, Number.isFinite(paneInsetPx) ? paneInsetPx : 0),
  );
  return { leftInsetPx: inset, widthPx: width - inset * 2 };
}

/** Whether a stored value is a placement. */
export function isRailPlacement(value: unknown): value is RailPlacement {
  const placement = value as { mode?: unknown } | null;
  return typeof placement === "object" && placement !== null
    && (placement.mode === "flow" || placement.mode === "pin")
    && Object.keys(placement).length === 1;
}
