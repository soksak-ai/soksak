// Split layout + drop hit test for the sidebar's section tree (SectionSetHost). Expands SplitTree<L>
// into % coordinate cells + split dividers and computes pointer → drop zone (5 zones). The content
// area's panes are on a plane of their own (state/panePlane) and are laid out by the library.

import type { SplitTree } from "../state/splitTree";

/**
 * How close two split coordinates must be to be the same line, and the least a
 * pane may be.
 *
 * They are stated here because this is where a line's coordinate is settled.
 * `state/verticalLines.ts` re-exports them so a gesture groups by the same
 * numbers the layout drew by — one rule, read from one place.
 */
export const LINE_EPS = 0.75;
export const MIN_FRAC = 0.08;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LayoutCell<L> {
  value: L;
  rect: Rect; // % of the container
}

export interface LayoutDivider {
  splitId: string;
  dir: "row" | "col";
  index: number;
  rect: Rect;
  spanPct: number;
  sizes: number[];
}

// Drop zone — center = move (join tabs), the rest = split in that direction.
export type DropZone = "center" | "left" | "right" | "top" | "bottom";

// SplitTree → cells (% coordinates) + split dividers. row = horizontal split, col = vertical split. (Generalized from GroupArea.computeLayout.)
export function computeSplitLayout<L>(
  node: SplitTree<L>,
  opts: { settle?: boolean } = {},
): {
  cells: LayoutCell<L>[];
  gutters: LayoutDivider[];
} {
  const cells: LayoutCell<L>[] = [];
  const gutters: LayoutDivider[] = [];
  const walk = (n: SplitTree<L>, r: Rect) => {
    if (n.type === "leaf") {
      cells.push({ value: n.value, rect: r });
      return;
    }
    if (n.dir === "row") {
      let x = r.left;
      n.children.forEach((c, i) => {
        const w = r.width * n.sizes[i];
        walk(c, { left: x, top: r.top, width: w, height: r.height });
        x += w;
        if (i < n.children.length - 1) {
          gutters.push({
            splitId: n.id,
            dir: "row",
            index: i,
            rect: { left: x, top: r.top, width: 0, height: r.height },
            spanPct: r.width,
            sizes: n.sizes,
          });
        }
      });
    } else {
      let y = r.top;
      n.children.forEach((c, i) => {
        const h = r.height * n.sizes[i];
        walk(c, { left: r.left, top: y, width: r.width, height: h });
        y += h;
        if (i < n.children.length - 1) {
          gutters.push({
            splitId: n.id,
            dir: "col",
            index: i,
            rect: { left: r.left, top: y, width: r.width, height: 0 },
            spanPct: r.height,
            sizes: n.sizes,
          });
        }
      });
    }
  };
  walk(node, { left: 0, top: 0, width: 100, height: 100 });
  // `settle: false` is for the one caller that settles the tree itself. It has
  // to see the coordinates the tree holds, not the ones the layout drew.
  if (opts.settle !== false) settleLines(cells, gutters);
  return { cells, gutters };
}

/**
 * A line is one thing, so it stands in one place.
 *
 * Each split holds its own sizes, so two splits that divide at the same place
 * arrive at coordinates a rounding — or a drag that left a segment behind —
 * apart. Everything downstream then applies a tolerance to group them into
 * one line, and while they are grouped, they are drawn in two places: the
 * boundary a gesture grabs is not the boundary anyone sees.
 *
 * The coordinate is settled here instead, once, and every segment and every
 * cell edge reads it.
 *
 * A segment whose neighbour is already at the minimum cannot come to the
 * shared x — moving it would draw a pane smaller than a pane may be. That one
 * is left where it stands, and is a different line, which is what it is.
 */
function settleLines<L>(cells: LayoutCell<L>[], gutters: LayoutDivider[]): void {
  for (const [dir, near, far] of [
    ["row", "left", "width"],
    ["col", "top", "height"],
  ] as const) {
    const along = gutters.filter((d) => d.dir === dir);
    if (along.length < 2) continue;

    const settled = new Map<number, number>();
    for (const group of cluster(along.map((d) => d.rect[near]))) {
      // Where every segment at these coordinates can stand, and where the ones
      // that can reach it are put.
      const members = along.filter((d) => group.includes(d.rect[near]));
      const at = group.reduce((n, v) => n + v, 0) / group.length;
      const reach = members.filter((d) => canStandAt(d, at, near));
      if (!reach.length) continue;
      const one = reach.reduce((n, d) => n + d.rect[near], 0) / reach.length;
      for (const d of reach) settled.set(d.rect[near], one);
    }
    if (!settled.size) continue;
    const move = (v: number) => settled.get(v) ?? v;

    for (const d of along) d.rect[near] = move(d.rect[near]);
    for (const c of cells) {
      const from = move(c.rect[near]);
      const to = move(c.rect[near] + c.rect[far]);
      c.rect[near] = from;
      c.rect[far] = to - from;
    }
  }
}

/** Whether a segment can stand at `x` without drawing a pane under the minimum. */
function canStandAt(d: LayoutDivider, x: number, near: "left" | "top"): boolean {
  const back = d.rect[near] - Math.max(0, d.sizes[d.index] - MIN_FRAC) * d.spanPct;
  const on = d.rect[near] + Math.max(0, d.sizes[d.index + 1] - MIN_FRAC) * d.spanPct;
  return x >= back - 1e-9 && x <= on + 1e-9;
}

/** Coordinates no further apart than `LINE_EPS`, walked in order. */
function cluster(values: number[]): number[][] {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const v of sorted) {
    const last = groups[groups.length - 1];
    if (last && v - last[last.length - 1] <= LINE_EPS) last.push(v);
    else groups.push([v]);
  }
  return groups;
}

// Pointer (clientX/Y) + container rect → which zone of which cell. (Generalized from GroupArea.hitTest.)
// chromeTop = header (tab row) px, statusPx = status bar px — they fix the body area (the outer ¼ is where a split lands).
// selfCenterOnly=true forces center over the drag source cell (no self split). idOf = cell identifier.
export function hitTestCells<L>(
  clientX: number,
  clientY: number,
  containerRect: DOMRect,
  cells: LayoutCell<L>[],
  idOf: (v: L) => string,
  opts: {
    chromeTop: number;
    statusPx: number;
    sourceId?: string;
    selfCenterOnly?: boolean;
  },
): { id: string; zone: DropZone } | null {
  const r = containerRect;
  const xPct = ((clientX - r.left) / r.width) * 100;
  const yPct = ((clientY - r.top) / r.height) * 100;
  const cell = cells.find(
    (c) =>
      xPct >= c.rect.left &&
      xPct <= c.rect.left + c.rect.width &&
      yPct >= c.rect.top &&
      yPct <= c.rect.top + c.rect.height,
  );
  if (!cell) return null;
  const id = idOf(cell.value);
  // Over the drag source cell: with selfCenterOnly a split is meaningless → center.
  if (id === opts.sourceId && opts.selfCenterOnly) {
    return { id, zone: "center" };
  }
  const cellTopPx = r.top + (cell.rect.top / 100) * r.height;
  const cellHpx = (cell.rect.height / 100) * r.height;
  const cellLeftPx = r.left + (cell.rect.left / 100) * r.width;
  const cellWpx = (cell.rect.width / 100) * r.width;
  const localY = clientY - cellTopPx;
  const bodyTop = opts.chromeTop;
  const bodyBottom = cellHpx - opts.statusPx;
  if (localY < bodyTop || localY > bodyBottom || bodyBottom <= bodyTop) {
    return { id, zone: "center" };
  }
  const px = (clientX - cellLeftPx) / cellWpx;
  const py = (localY - bodyTop) / (bodyBottom - bodyTop);
  const edge = 0.25;
  if (px > edge && px < 1 - edge && py > edge && py < 1 - edge) {
    return { id, zone: "center" };
  }
  const dl = px;
  const dr = 1 - px;
  const dt = py;
  const db = 1 - py;
  const m = Math.min(dl, dr, dt, db);
  const zone: DropZone =
    m === dl ? "left" : m === dr ? "right" : m === dt ? "top" : "bottom";
  return { id, zone };
}

// Cell coordinates → 4 CSS variables (--l/--t/--w/--h). The arithmetic is owned by a single CSS rule (.drop-ind-wrap and such).
export function cellVars(rect: Rect): Record<string, string> {
  return {
    "--l": `${rect.left}%`,
    "--t": `${rect.top}%`,
    "--w": `${rect.width}%`,
    "--h": `${rect.height}%`,
  };
}

/**
 * The canonical name of a sidebar gutter: the first leaf in document order touching the trailing
 * face of the child before the seam. The seam of children i and i+1 of a split is the trailing face
 * of child i, and that subtree always holds a leaf on that face — descend to the last child along
 * the split's axis, to the first child across it.
 */
export function treeGutterOwnerOf<L>(
  tree: SplitTree<L>,
  splitId: string,
  index: number,
  idOf: (leaf: L) => string,
): { pane: string; side: "right" | "bottom" } | null {
  const node = splitNodeById(tree, splitId);
  if (!node) return null;
  if (index < 0 || index >= node.children.length - 1) return null;
  const trailing = (n: SplitTree<L>, axis: "row" | "col"): L =>
    n.type === "leaf"
      ? n.value
      : trailing(n.dir === axis ? n.children[n.children.length - 1] : n.children[0], axis);
  return {
    pane: idOf(trailing(node.children[index], node.dir)),
    side: node.dir === "row" ? "right" : "bottom",
  };
}

function splitNodeById<L>(
  node: SplitTree<L>,
  splitId: string,
): Extract<SplitTree<L>, { type: "split" }> | null {
  if (node.type === "leaf") return null;
  if (node.id === splitId) return node;
  for (const c of node.children) {
    const hit = splitNodeById(c, splitId);
    if (hit) return hit;
  }
  return null;
}
