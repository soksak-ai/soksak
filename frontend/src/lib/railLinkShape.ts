import {
  projectRailRect,
  railLeftPx,
  type RailRect,
} from "./railPlacement";

export interface Point {
  x: number;
  y: number;
}

export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Inset only the outline so the outer half of a stroke on the SVG viewport edge is not clipped. */
export function insetClippedEdges(
  points: Point[],
  width: number,
  height: number,
  inset: number,
): Point[] {
  const amount = Math.max(0, inset);
  return points.map(({ x, y }) => ({
    x: x <= 0 ? amount : x >= width ? Math.max(amount, width - amount) : x,
    y: y <= 0 ? amount : y >= height ? Math.max(amount, height - amount) : y,
  }));
}

// Non-adjacency suppression tolerance (logical %p). A linked cell always starts at the clean
// line (rail station), so a larger gap is not float error but a mid-state where the box does not
// yet touch the rail.
export const RAIL_LINK_ADJACENT_TOLERANCE = 1;

export type RailRelationSide = "left" | "right" | "detached";

/** Single criterion classifying which rail edge the actual logical rect touches. */
export function classifyRailRelation(
  station: number,
  target: RailRect,
): RailRelationSide {
  const right = target.left + target.width;
  if (Math.abs(right - station) <= RAIL_LINK_ADJACENT_TOLERANCE) return "left";
  if (Math.abs(target.left - station) <= RAIL_LINK_ADJACENT_TOLERANCE) return "right";
  return "detached";
}

/**
 * Whether rail and linked box draw as one border — the relation-surface render gate.
 *
 * The linked box **starts at the rail** (App builds it that way: from the rail to the right end
 * of the joined panel). So mode does not matter here — pull or rail travel, the box's left edge
 * is the station. A widened gap is a mid-state not yet arrived, so suppress it.
 */
export function railLinkAdjacent(station: number, target: RailRect): boolean {
  return classifyRailRelation(station, target) !== "detached";
}

/** Resolve the logical panel rect and the fixed-width rail into the same px coordinate space. */
export function railLinkBoxes(
  hostWidth: number,
  hostHeight: number,
  railWidth: number,
  station: number,
  target: RailRect,
): { rail: PixelBox; panel: PixelBox } | null {
  if (hostWidth <= 0 || hostHeight <= 0 || railWidth <= 0) return null;
  // The host is the reference — do not subtract the right-placed rail again here (the host is already narrow).
  const projected = projectRailRect(target, station, hostWidth, railWidth);
  return {
    rail: {
      x: railLeftPx(hostWidth, railWidth, station),
      y: 0,
      width: railWidth,
      height: hostHeight,
    },
    panel: {
      x: projected.left,
      y: (target.top / 100) * hostHeight,
      width: projected.width,
      height: (target.height / 100) * hostHeight,
    },
  };
}

function compact(points: Point[]): Point[] {
  return points.filter((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    if (point.x === previous.x && point.y === previous.y) return false;
    return !(
      (previous.x === point.x && point.x === next.x) ||
      (previous.y === point.y && point.y === next.y)
    );
  });
}

/**
 * Union outline of the full-height rail and the panel immediately to its right. A detached panel
 * makes an intermediate panel read as the relation surface, so it returns null.
 */
export function railLinkPolygon(
  rail: PixelBox,
  panel: PixelBox,
  epsilon = 0.5,
): Point[] | null {
  const railRight = rail.x + rail.width;
  const paneRight = panel.x + panel.width;
  const paneBottom = panel.y + panel.height;
  if (Math.abs(paneRight - rail.x) <= epsilon) {
    return compact([
      { x: rail.x, y: rail.y },
      { x: railRight, y: rail.y },
      { x: railRight, y: rail.y + rail.height },
      { x: rail.x, y: rail.y + rail.height },
      { x: rail.x, y: paneBottom },
      { x: panel.x, y: paneBottom },
      { x: panel.x, y: panel.y },
      { x: rail.x, y: panel.y },
    ]);
  }
  if (Math.abs(panel.x - railRight) > epsilon) return null;
  return compact([
    { x: rail.x, y: rail.y },
    { x: railRight, y: rail.y },
    { x: railRight, y: panel.y },
    { x: paneRight, y: panel.y },
    { x: paneRight, y: paneBottom },
    { x: railRight, y: paneBottom },
    { x: railRight, y: rail.y + rail.height },
    { x: rail.x, y: rail.y + rail.height },
  ]);
}

const fmt = (value: number) => Number(value.toFixed(2)).toString();

interface RoundedCorner {
  current: Point;
  before: Point;
  after: Point;
}

// Corner rounding computation — closed path and split path share the same geometry (shape invariance contract).
function roundedCorners(points: Point[], radius: number): RoundedCorner[] {
  return points.map((current, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const beforeLength = Math.hypot(current.x - previous.x, current.y - previous.y);
    const afterLength = Math.hypot(next.x - current.x, next.y - current.y);
    const r = Math.min(radius, beforeLength / 2, afterLength / 2);
    const toward = (other: Point, distance: number): Point => ({
      x: current.x + ((other.x - current.x) / Math.hypot(other.x - current.x, other.y - current.y)) * distance,
      y: current.y + ((other.y - current.y) / Math.hypot(other.x - current.x, other.y - current.y)) * distance,
    });
    return { current, before: toward(previous, r), after: toward(next, r) };
  });
}

/** SVG path of an orthogonal polygon rounded by the theme radius. */
export function roundedOrthogonalPath(points: Point[], radius: number): string {
  if (points.length < 3) return "";
  if (radius <= 0) {
    return `${points.map((p, i) => `${i === 0 ? "M" : "L"} ${fmt(p.x)} ${fmt(p.y)}`).join(" ")} Z`;
  }
  const corners = roundedCorners(points, radius);
  const last = corners[corners.length - 1];
  return [
    `M ${fmt(last.after.x)} ${fmt(last.after.y)}`,
    ...corners.flatMap(({ current, before, after }) => [
      `L ${fmt(before.x)} ${fmt(before.y)}`,
      `Q ${fmt(current.x)} ${fmt(current.y)} ${fmt(after.x)} ${fmt(after.y)}`,
    ]),
    "Z",
  ].join(" ");
}


/** Round-preserving split for option B (dashed edge) — find the rightmost vertical edge; the
 * dashed part is only the straight run "between" that edge's two corner arcs, the solid part is
 * everything else including the corner arcs (open path). Joined, the shape equals the original
 * rounded outline (shape invariance contract — no square corners). */
export function splitRightEdgeRounded(
  points: Point[],
  radius: number,
): { solid: string; edge: [Point, Point] } | null {
  if (points.length < 3) return null;
  const maxX = Math.max(...points.map((p) => p.x));
  const eps = 1e-6;
  let start = -1;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (Math.abs(a.x - maxX) < eps && Math.abs(b.x - maxX) < eps) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const corners = roundedCorners(points, Math.max(radius, 0));
  const a = corners[start]; // Edge start corner — the arc is solid, after is the dashed start point.
  const b = corners[(start + 1) % points.length]; // Edge end corner — before is the dashed end point.
  const parts: string[] = [`M ${fmt(b.before.x)} ${fmt(b.before.y)}`];
  for (let k = 1; k <= points.length; k += 1) {
    const c = corners[(start + k) % points.length];
    if (k > 1) parts.push(`L ${fmt(c.before.x)} ${fmt(c.before.y)}`);
    parts.push(
      `Q ${fmt(c.current.x)} ${fmt(c.current.y)} ${fmt(c.after.x)} ${fmt(c.after.y)}`,
    );
  }
  return { solid: parts.join(" "), edge: [a.after, b.before] };
}
