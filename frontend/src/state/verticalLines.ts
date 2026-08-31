// Vertical no-split proposition — a clean vertical line has one identity over its full height. Whatever the
// gesture (drag, double-click equalize) and whichever segment is grabbed, the whole line moves together; a
// gesture can move a line but never split it. The single owner of the pure logic is here — the GroupArea
// gesture handler and restore (windowSnapshot) only consume it.
//
// A line = vertical (row) divider segments whose x match within tolerance and whose y ranges do not overlap.
// Dividers sharing a y range are a different parallel line, not segments of one line — that rule also excludes
// ancestor/descendant dividers (a descendant's y is a subset of the ancestor divider's y), so the segments of
// one group are always in mutually independent splits (a single batch application is exact).
//
// The two eps values have different roles — the boundary is when they apply, not their value:
// · LINE_GROUP_EPS(0.75) = runtime rule. The range grouped as "one line" at gesture start.
// · LINE_SNAP_EPS(1.5) = one-time legacy healing. Fragmented lines are snapped only on the first restore of an
//   old snapshot without the vlNormalized marker (windowSnapshot is the gate). Later restores are identity, so
//   restore never rewrites a separate line the user placed outside the runtime rule (0.75 to 1.5).

import { computeSplitLayout, type LayoutDivider } from "../lib/splitLayout";
import { CHROME_BANDS } from "../lib/chromeBands";
import { resizeSplitTree, type SplitTree } from "./splitTree";

// Minimum pane fraction (relative to that split's span) — single source for the drag clamp and the normalization guard.
export const MIN_PANE_FRAC = 0.08;
// A pane must retain its fixed chrome plus at least one CSS pixel of body. The
// fraction is calculated from the actual split span at gesture time; a fixed
// fraction alone can still collapse the native viewport in a short split.
// Native providers need two complete common chrome bands: one for the first
// content row and one for compositor rounding/inset. This is a contract floor,
// not a provider-specific value.
export const MIN_PANE_BODY_PX = CHROME_BANDS.header * 2;

export function minPaneFracForSpan(
  spanPx: number,
  chromePx: number,
  bodyPx: number = MIN_PANE_BODY_PX,
  baseFrac: number = MIN_PANE_FRAC,
): number {
  if (!Number.isFinite(spanPx) || spanPx <= 0) return baseFrac;
  const requiredPx = Math.max(0, chromePx) + Math.max(0, bodyPx);
  return Math.max(baseFrac, Math.min(0.5, requiredPx / spanPx));
}
// Companion grouping tolerance (%p) — the range taken as one line at gesture start (runtime rule).
export const LINE_GROUP_EPS = 0.75;
// Restore normalization tolerance (%p) — the range that snaps fragmented lines of a marker-less old snapshot to
// a common x (one-time legacy healing only — not used on the runtime path).
export const LINE_SNAP_EPS = 1.5;

const TINY = 1e-9;

export interface LineMove {
  splitId: string;
  sizes: number[];
}

// Whether the y ranges overlap (touching boundaries is not overlap).
const yOverlaps = (a: LayoutDivider, b: LayoutDivider): boolean =>
  a.rect.top < b.rect.top + b.rect.height - TINY &&
  b.rect.top < a.rect.top + a.rect.height - TINY;

// The vertical divider group that forms one line with the anchor at gesture start (anchor included, ascending
// by top). Among candidates with overlapping y (a different parallel line) only the one nearest the anchor x is
// kept. A segment whose allowed range does not contain the anchor's start x (a neighbor squeezed to minimum
// width) is never grouped — the remaining group is the largest valid subset that includes the anchor and whose
// intersection contains the start x (the clamp cannot be empty), and once grouped, a gesture never tears a
// segment out.
export function collectLineGroup(
  gutters: LayoutDivider[],
  anchorSplitId: string,
  anchorIndex: number,
  eps: number = LINE_GROUP_EPS,
): LayoutDivider[] {
  const rows = gutters.filter((d) => d.dir === "row");
  const anchor = rows.find(
    (d) => d.splitId === anchorSplitId && d.index === anchorIndex,
  );
  if (!anchor) return [];
  const anchorX = anchor.rect.left;
  const reachesAnchorX = (d: LayoutDivider): boolean => {
    const r = lineGroupRange([d]);
    return anchorX >= r.min - TINY && anchorX <= r.max + TINY;
  };
  const candidates = rows
    .filter(
      (d) =>
        d !== anchor &&
        Math.abs(d.rect.left - anchorX) <= eps &&
        reachesAnchorX(d),
    )
    .sort(
      (a, b) =>
        Math.abs(a.rect.left - anchorX) - Math.abs(b.rect.left - anchorX) ||
        a.rect.top - b.rect.top,
    );
  const group = [anchor];
  for (const c of candidates) {
    if (group.every((m) => !yOverlaps(m, c))) group.push(c);
  }
  return group.sort((a, b) => a.rect.top - b.rect.top);
}

// The x range the group can move to together = the intersection of each segment's allowed range. Each range
// always contains its own current x — a neighbor already below minFrac only has to not shrink further, so the
// lower bound is 0 (max(0,…)).
export function lineGroupRange(
  group: LayoutDivider[],
  minFrac: number = MIN_PANE_FRAC,
): { min: number; max: number } {
  let min = 0;
  let max = 100;
  for (const d of group) {
    min = Math.max(
      min,
      d.rect.left - Math.max(0, d.sizes[d.index] - minFrac) * d.spanPct,
    );
    max = Math.min(
      max,
      d.rect.left + Math.max(0, d.sizes[d.index + 1] - minFrac) * d.spanPct,
    );
  }
  return { min, max };
}

// Move the whole group to targetX (clamped to the intersection) — new sizes per split. The returned x is the
// common x actually moved to. Even when per-segment start x differ within tolerance, all join at the same x
// (line unification).
export function moveLineGroup(
  group: LayoutDivider[],
  targetX: number,
  minFrac: number = MIN_PANE_FRAC,
): { x: number; moves: LineMove[] } {
  if (group.length === 0) return { x: targetX, moves: [] };
  const range = lineGroupRange(group, minFrac);
  // collectLineGroup blocks the empty set, but this guards arbitrary group input — no move.
  if (range.min > range.max + TINY) return { x: group[0].rect.left, moves: [] };
  const x = Math.min(range.max, Math.max(range.min, targetX));
  const sizesBySplit = new Map<string, number[]>();
  for (const d of group) {
    if (d.spanPct <= 0) continue;
    const sizes = sizesBySplit.get(d.splitId) ?? [...d.sizes];
    const delta = (x - d.rect.left) / d.spanPct;
    sizes[d.index] += delta;
    sizes[d.index + 1] -= delta;
    sizesBySplit.set(d.splitId, sizes);
  }
  return {
    x,
    moves: [...sizesBySplit].map(([splitId, sizes]) => ({ splitId, sizes })),
  };
}

// Double-click equalize — computes the target x that makes the anchor divider's two adjacent panes equal and
// moves the whole line group to that x (intersection clamp included). The proposition is independent of the
// gesture kind — equalize takes the same collectLineGroup + moveLineGroup path as drag, so the line does not
// tear. When the target is outside the intersection, no-split wins over an exact half (the group stands
// together on the clamped common x).
export function equalizeLineGroup(
  gutters: LayoutDivider[],
  anchorSplitId: string,
  anchorIndex: number,
): { x: number; moves: LineMove[] } {
  const group = collectLineGroup(gutters, anchorSplitId, anchorIndex);
  const anchor = group.find(
    (d) => d.splitId === anchorSplitId && d.index === anchorIndex,
  );
  if (!anchor) return { x: 0, moves: [] };
  const half = (anchor.sizes[anchorIndex] + anchor.sizes[anchorIndex + 1]) / 2;
  const targetX =
    anchor.rect.left + (half - anchor.sizes[anchorIndex]) * anchor.spanPct;
  return moveLineGroup(group, targetX);
}

// split id → depth (root 0) — the ancestor-first application order for normalization.
function splitDepths<L>(tree: SplitTree<L>): Map<string, number> {
  const depths = new Map<string, number>();
  const walk = (n: SplitTree<L>, depth: number): void => {
    if (n.type === "leaf") return;
    depths.set(n.id, depth);
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(tree, 0);
  return depths;
}

// One-time restore normalization (self-healing) — snaps vertical lines misaligned within eps to a common x (the
// x of the topmost segment). An idempotent transform that fixes in the data the pollution left by fragmented
// resizes from before companion drag. When the snap would shrink a pane below minFrac, that segment is left
// alone (healing must not become destruction). With no change, the original reference is returned.
export function normalizeVerticalLines<L>(
  tree: SplitTree<L>,
  eps: number = LINE_SNAP_EPS,
  minFrac: number = MIN_PANE_FRAC,
): SplitTree<L> {
  if (tree.type === "leaf") return tree;
  const rows = computeSplitLayout(tree)
    .gutters.filter((d) => d.dir === "row")
    .sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);
  // Clusters of nearby x (eps relative to the cluster minimum) → line candidates.
  const clusters: LayoutDivider[][] = [];
  for (const d of rows) {
    const cluster = clusters[clusters.length - 1];
    if (cluster && d.rect.left - cluster[0].rect.left <= eps) cluster.push(d);
    else clusters.push([d]);
  }
  // Snap plan: anchor = topmost segment, target = anchor x. Already-aligned segments stay in the plan — even if
  // an ancestor line's snap shifts a descendant line wholesale, recomputing at apply time reseats it.
  const plans: { splitId: string; index: number; targetX: number }[] = [];
  for (const cluster of clusters) {
    if (cluster.length < 2) continue;
    const anchor = [...cluster].sort(
      (a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left,
    )[0];
    const targetX = anchor.rect.left;
    const members: LayoutDivider[] = [];
    for (const c of [...cluster].sort(
      (a, b) =>
        Math.abs(a.rect.left - targetX) - Math.abs(b.rect.left - targetX) ||
        a.rect.top - b.rect.top,
    )) {
      if (members.every((m) => !yOverlaps(m, c))) members.push(c);
    }
    if (members.length < 2) continue;
    for (const m of members) {
      plans.push({ splitId: m.splitId, index: m.index, targetX });
    }
  }
  if (plans.length === 0) return tree;
  // Apply ancestor splits first — changing ancestor sizes moves descendant divider x, so the shallow ones are
  // fixed first and the layout is recomputed before each apply to seat every segment exactly on its target.
  const depth = splitDepths(tree);
  plans.sort(
    (a, b) => (depth.get(a.splitId) ?? 0) - (depth.get(b.splitId) ?? 0),
  );
  let current: SplitTree<L> = tree;
  let changed = false;
  for (const plan of plans) {
    const d: LayoutDivider | undefined = computeSplitLayout(
      current,
    ).gutters.find(
      (v) =>
        v.dir === "row" && v.splitId === plan.splitId && v.index === plan.index,
    );
    if (!d || d.spanPct <= 0) continue;
    const delta = (plan.targetX - d.rect.left) / d.spanPct;
    if (Math.abs(delta) <= TINY) continue;
    const sizes: number[] = [...d.sizes];
    const nextA = sizes[plan.index] + delta;
    const nextB = sizes[plan.index + 1] - delta;
    const shrinksBelowMin = (next: number, cur: number) =>
      next < cur - TINY && next < minFrac - TINY;
    if (
      shrinksBelowMin(nextA, sizes[plan.index]) ||
      shrinksBelowMin(nextB, sizes[plan.index + 1])
    ) {
      continue;
    }
    sizes[plan.index] = nextA;
    sizes[plan.index + 1] = nextB;
    current = resizeSplitTree(current, plan.splitId, sizes);
    changed = true;
  }
  return changed ? current : tree;
}
