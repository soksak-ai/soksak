// Split layout + drop hit test — one machine shared by the content area (GroupArea) and the left sidebar
// (LeftSidebarHost). Expands SplitTree<L> into % coordinate cells + split dividers and computes pointer →
// drop zone (5 zones). [RULE] Both areas must behave identically, so layout and hit test exist only here (no duplicates).

import type { SplitTree } from "../state/splitTree";

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
export function computeSplitLayout<L>(node: SplitTree<L>): {
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
  return { cells, gutters };
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
