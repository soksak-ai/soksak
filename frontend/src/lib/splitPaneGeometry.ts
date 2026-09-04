import { SplitPane } from "split-pane";
import type { CardInit, SplitPaneState, ZoneOptions } from "split-pane";

export type Rect = { left: number; top: number; width: number; height: number };
export type GridLayout<L> = Omit<SplitPaneState, "cards"> & {
  cards: Array<Omit<CardInit, "data"> & { data: L }>;
};

export function gridOf<L>(layout: GridLayout<L>, width = 100, height = 100): SplitPane {
  return new SplitPane(layout, { width, height, gap: 0, minSize: 0 });
}

export function layoutCells<L>(layout: GridLayout<L>): Array<{ value: L; rect: Rect }> {
  const grid = gridOf(layout);
  const rects = grid.rects();
  return layout.cards.map((card) => {
    const rect = rects.get(card.id)!;
    return { value: card.data, rect: { left: rect.x, top: rect.y, width: rect.w, height: rect.h } };
  });
}

export function layoutDividers<L>(layout: GridLayout<L>) {
  const grid = gridOf(layout);
  return grid.dividers().map((divider) => ({
    splitId: `${divider.axis}:${divider.line}`,
    dir: divider.axis === "x" ? "row" as const : "col" as const,
    index: divider.line,
    rect: { left: divider.x, top: divider.y, width: divider.w, height: divider.h },
    spanPct: divider.axis === "x" ? divider.h : divider.w,
    sizes: grid.lines(divider.axis),
  }));
}

export function zoneAt<L>(layout: GridLayout<L>, x: number, y: number, options?: ZoneOptions) {
  return gridOf(layout).zoneAt(x, y, options);
}

export function cellVars(rect: Rect): Record<string, string> {
  return {
    "--l": `${rect.left}%`,
    "--t": `${rect.top}%`,
    "--w": `${rect.width}%`,
    "--h": `${rect.height}%`,
  };
}
