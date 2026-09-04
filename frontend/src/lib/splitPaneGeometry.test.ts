import { describe, expect, it } from "vitest";
import { SplitPane } from "split-pane";
import { layoutCells, layoutDividers, zoneAt } from "./splitPaneGeometry";

const layout = {
  xs: [0, 0.5, 1],
  ys: [0, 1],
  cards: [
    { id: "left", c0: 0, c1: 1, r0: 0, r1: 1, data: { id: "left" } },
    { id: "right", c0: 1, c1: 2, r0: 0, r1: 1, data: { id: "right" } },
  ],
};

describe("SplitPane geometry boundary", () => {
  it("uses library rectangles and dividers", () => {
    const direct = new SplitPane(layout, { width: 100, height: 100, gap: 0, minSize: 0 });
    expect(layoutCells(layout)).toEqual([
      { value: { id: "left" }, rect: { left: direct.rect("left")!.x, top: direct.rect("left")!.y, width: direct.rect("left")!.w, height: direct.rect("left")!.h } },
      { value: { id: "right" }, rect: { left: direct.rect("right")!.x, top: direct.rect("right")!.y, width: direct.rect("right")!.w, height: direct.rect("right")!.h } },
    ]);
    expect(layoutDividers(layout)).toHaveLength(1);
  });

  it("resolves a drop through SplitPane zoneAt", () => {
    expect(zoneAt(layout, 10, 50)?.id).toBe("left");
    expect(zoneAt(layout, 90, 50)?.id).toBe("right");
  });
});
