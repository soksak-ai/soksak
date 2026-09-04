import type { LayoutDivider } from "./splitLayout";
import { railStationFromLeftPx } from "./railPlacement";
import { collectLineGroup, moveLineGroup, type LineMove } from "../state/verticalLines";

export interface RailWidthResizePlan {
  /** Width that can be applied without breaking the pane minimums. */
  widthPx: number;
  /** New logical clean line which preserves the old physical rail left edge. */
  station: number;
  leftPx: number;
  rightPx: number;
  moves: LineMove[];
}

/**
 * Couples an interior flow rail's width to the canonical line it occupies.
 *
 * The rail is inserted into a pane plane, so its physical left is
 * `(hostWidth - railWidth) * station`. Keeping station fixed while width changes moves both rail
 * edges and steals room from both neighboring panes. A right-hand grip instead owns one invariant:
 * the physical left stays fixed. The canonical line therefore moves by the exact amount required
 * to preserve that invariant, through the same vertical-line rule used by a gutter drag.
 */
export function railWidthResizePlan({
  gutters,
  startStation,
  hostWidthPx,
  startWidthPx,
  requestedWidthPx,
}: {
  gutters: LayoutDivider[];
  startStation: number;
  hostWidthPx: number;
  startWidthPx: number;
  requestedWidthPx: number;
}): RailWidthResizePlan | null {
  if (![startStation, hostWidthPx, startWidthPx, requestedWidthPx].every(Number.isFinite)
      || hostWidthPx <= 0 || startStation <= 0 || startStation >= 100) return null;
  const rows = gutters.filter((gutter) => gutter.dir === "row");
  const anchor = rows.reduce<LayoutDivider | null>((best, gutter) => (
    best === null || Math.abs(gutter.rect.left - startStation) < Math.abs(best.rect.left - startStation)
      ? gutter : best
  ), null);
  if (!anchor || Math.abs(anchor.rect.left - startStation) > 0.75) return null;

  const leftPx = ((hostWidthPx - startWidthPx) * startStation) / 100;
  const requestedStation = railStationFromLeftPx(leftPx, hostWidthPx, requestedWidthPx);
  const moved = moveLineGroup(
    collectLineGroup(gutters, anchor.splitId, anchor.index),
    requestedStation,
  );
  if (moved.moves.length === 0) return null;

  // If pane minimums clamp the clean line, clamp the width by the inverse of the same equation.
  const widthPx = Math.abs(moved.x - requestedStation) < 1e-9
    ? requestedWidthPx
    : hostWidthPx - (leftPx * 100) / moved.x;
  return {
    widthPx,
    station: moved.x,
    leftPx,
    rightPx: leftPx + widthPx,
    moves: moved.moves,
  };
}
