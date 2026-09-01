// Left rail geometry. The panel grid stays on the 0..100 logical plane, and the rail is inserted
// at a clean vertical line of that plane as a discontinuous span of fixed px width. This file owns
// the **geometric mapping** only — which line it is placed on (station) and which arrangement is
// drawn are solved by the placement resolver (railArrangement). DOM focus and pixel measurement
// are not the authority for position: the FLOW input is the panel id of the session active chain.

// flow = the rail is placed on the clean line left of the focused panel (user-confirmed design —
// the sidebar attaches to the function tab). pin = it is placed on the line anchored with the
// grip. The width is invariant regardless of station, so no panel grows or shrinks when the
// insertion point moves — only a panel the rail crosses translates by the rail width.
export type RailPlacement = { mode: "flow" } | { mode: "pin"; station: number };

export interface RailRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RailCell {
  id: string;
  rect: RailRect;
}

export interface RailCssRect extends RailRect {
  /** Coefficient multiplied by `railWidthPx` and added to the logical left. */
  railLeft: number;
  /** Coefficient multiplied by `railWidthPx` and added to the logical width (always 0 or less). */
  railWidth: number;
}

export const DEFAULT_RAIL_PLACEMENT: RailPlacement = { mode: "flow" };
export const RAIL_EPSILON = 0.01;

export interface InsetRailRect {
  leftInsetPx: number;
  widthPx: number;
}

/** Visible rail frame inside its fixed reservation; the reservation itself never changes. */
export function insetRailRect(allocatedWidthPx: number, paneInsetPx: number): InsetRailRect {
  const width = Math.max(0, Number.isFinite(allocatedWidthPx) ? allocatedWidthPx : 0);
  const inset = Math.min(
    width / 2,
    Math.max(0, Number.isFinite(paneInsetPx) ? paneInsetPx : 0),
  );
  return { leftInsetPx: inset, widthPx: width - inset * 2 };
}

const clampStation = (value: number): number =>
  Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

function epsilonUnique(values: number[], eps: number): number[] {
  const sorted = values.map(clampStation).sort((a, b) => a - b);
  const result: number[] = [];
  let cluster: number[] = [];
  const flush = () => {
    if (cluster.length === 0) return;
    result.push(cluster.reduce((sum, value) => sum + value, 0) / cluster.length);
    cluster = [];
  };
  for (const value of sorted) {
    if (cluster.length === 0 || value - cluster[cluster.length - 1] <= eps) {
      cluster.push(value);
    } else {
      flush();
      cluster.push(value);
    }
  }
  flush();
  return result;
}

/** Full-height vertical lines that cross the inside of no panel. */
export function cleanRailLines(
  rects: RailRect[],
  eps: number = RAIL_EPSILON,
): number[] {
  const candidates = epsilonUnique(
    [0, 100, ...rects.flatMap((rect) => [rect.left, rect.left + rect.width])],
    eps,
  );
  return candidates.filter((x) =>
    rects.every(
      (rect) => x <= rect.left + eps || x >= rect.left + rect.width - eps,
    ),
  );
}


/** Grip/PIN normalization: the nearest clean line. On a tie, the earlier (left) line. */
export function snapRailStation(lines: number[], wanted: number): number {
  const sorted = epsilonUnique(lines, RAIL_EPSILON);
  if (sorted.length === 0) return 0;
  const target = clampStation(wanted);
  let best = sorted[0];
  let distance = Math.abs(target - best);
  for (const line of sorted.slice(1)) {
    const nextDistance = Math.abs(target - line);
    if (nextDistance < distance) {
      best = line;
      distance = nextDistance;
    }
  }
  return best;
}

/** Checks whether a committed PIN matches an actual clean line exactly. */
export function isCleanRailStation(
  lines: number[],
  station: number,
  eps: number = RAIL_EPSILON,
): boolean {
  return (
    Number.isFinite(station) &&
    lines.some((line) => Math.abs(line - station) <= eps)
  );
}

type RailSide = "before" | "after";

function sideOf(
  rect: Pick<RailRect, "left" | "width">,
  station: number,
  eps: number = RAIL_EPSILON,
): RailSide {
  const right = rect.left + rect.width;
  if (right <= station + eps) return "before";
  if (rect.left >= station - eps) return "after";
  throw new Error(
    `rail station ${station} crosses panel ${rect.left}..${right}`,
  );
}

/**
 * Measurement-free mapping for CSS. The final left/width are
 * `calc(left% + railLeft * railWidthPx)` and `calc(width% + railWidth * railWidthPx)`.
 */
export function projectRailCssRect(
  rect: RailRect,
  station: number,
): RailCssRect {
  const side = sideOf(rect, station);
  return {
    ...rect,
    railLeft: (side === "after" ? 1 : 0) - rect.left / 100,
    railWidth: -rect.width / 100,
  };
}

export interface RailCssTransition {
  source: RailCssRect;
  target: RailCssRect;
}

/**
 * Workspaces both geometries of a FLOW transition under one contract. The source station applies to
 * the source rect only, the target station to the target rect only. When the panel arrangement and
 * the rail line change together in the same render, mixing values from different moments makes a
 * source line that was valid cross the target panel, so the caller cannot assemble the two workspace
 * calls separately.
 */
export function projectRailCssTransition(
  sourceRect: RailRect,
  sourceStation: number,
  targetRect: RailRect,
  targetStation: number,
): RailCssTransition {
  return {
    source: projectRailCssRect(sourceRect, sourceStation),
    target: projectRailCssRect(targetRect, targetStation),
  };
}

/**
 * CSS mapping for a decorative span that may cross the rail, such as a divider. Never use it for a
 * panel. A span crossing the rail includes the physical gap, and the actual rail frame covers it.
 */
export function projectRailCssSpan(
  rect: RailRect,
  station: number,
): RailCssRect {
  const right = rect.left + rect.width;
  if (right <= station + RAIL_EPSILON || rect.left >= station - RAIL_EPSILON) {
    return projectRailCssRect(rect, station);
  }
  return {
    ...rect,
    railLeft: -rect.left / 100,
    railWidth: 1 - rect.width / 100,
  };
}

/** Pixel-based reference mapping (for tests and UI drag math). top/height stay the vertical logical values. */
/**
 * Workspaces a cell's percentages into host pixels.
 *
 * **The host provides the reference width.** The pane area is the host minus the rail only —
 * because the rail is placed *inside* the host. What is placed outside the host (a push sidebar)
 * is not subtracted here: when it is present, the host itself is already that much narrower.
 *
 * Re-legislated (2026-08-02, measured): `rightInsetPx` was subtracted once more here. In push mode
 * the drawn border's right edge was at window 1017px while the combined pane's right edge was
 * 1336px — short by exactly the sidebar width (the overlay host width was also already narrower,
 * 1204 vs 1529 in overlay mode). The commit that added it (ac9a1e58) saw the "diagonal" symptom
 * and diagnosed it as "not subtracted", but the host is already narrow, so not subtracting cannot
 * overflow. One more thing to subtract means that value gets counted twice eventually — so the
 * parameter is removed. A parameter that does not exist cannot be wrong.
 */
export function projectRailRect(
  rect: RailRect,
  station: number,
  hostWidthPx: number,
  railWidthPx: number,
): RailRect {
  const side = sideOf(rect, station);
  const paneWidth = Math.max(0, hostWidthPx - railWidthPx);
  return {
    left:
      (paneWidth * rect.left) / 100 +
      (side === "after" ? railWidthPx : 0),
    top: rect.top,
    width: (paneWidth * rect.width) / 100,
    height: rect.height,
  };
}

export function railLeftPx(
  hostWidthPx: number,
  railWidthPx: number,
  station: number,
): number {
  return (
    (Math.max(0, hostWidthPx - railWidthPx) * clampStation(station)) / 100
  );
}

/** Converts the physical left the grip points at back to the fixed-width rail's logical station (0..100). */
export function railStationFromLeftPx(
  railLeft: number,
  hostWidthPx: number,
  railWidthPx: number,
): number {
  const paneWidth = Math.max(0, hostWidthPx - railWidthPx);
  if (paneWidth === 0) return 0;
  return clampStation((railLeft / paneWidth) * 100);
}

/**
 * Converts a physical x with the rail inserted (from the container's left) back to continuous
 * logical panel px. Inside the rail is not a panel, so null (R8 rail inviolability).
 */
export function unprojectRailX(
  physicalX: number,
  hostWidthPx: number,
  railWidthPx: number,
  station: number,
): number | null {
  const railLeft = railLeftPx(hostWidthPx, railWidthPx, station);
  if (physicalX < railLeft) return physicalX;
  if (physicalX > railLeft + railWidthPx) return physicalX - railWidthPx;
  return null;
}

/** Restore parse — a station outside the plane or a corrupted value falls back to the default (flow). */
export function normalizeRailPlacement(value: unknown): RailPlacement {
  const placement = (value ?? {}) as { mode?: unknown; station?: unknown };
  if (placement.mode === "pin") {
    return typeof placement.station === "number" &&
      Number.isFinite(placement.station) &&
      placement.station >= 0 &&
      placement.station <= 100
      ? { mode: "pin", station: placement.station }
      : DEFAULT_RAIL_PLACEMENT;
  }
  return DEFAULT_RAIL_PLACEMENT;
}
