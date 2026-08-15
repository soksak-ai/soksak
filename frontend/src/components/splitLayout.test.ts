import { describe, it, expect } from "vitest";
import { computeSplitLayout, hitTestCells } from "../lib/splitLayout";
import type { SplitTree } from "../state/splitTree";

// Shared split layout — same for content and sidebar. Independent of the leaf value (verified with L=string).
type T = SplitTree<string>;

describe("computeSplitLayout", () => {
  it("one leaf = the whole rect", () => {
    const { cells, gutters } = computeSplitLayout<string>({ type: "leaf", value: "a" });
    expect(cells).toEqual([{ value: "a", rect: { left: 0, top: 0, width: 100, height: 100 } }]);
    expect(gutters).toEqual([]);
  });

  it("col split = 2 stacked cells + 1 gutter", () => {
    const t: T = {
      type: "split",
      id: "spl-aaaaaa",
      dir: "col",
      sizes: [0.7, 0.3],
      children: [
        { type: "leaf", value: "a" },
        { type: "leaf", value: "b" },
      ],
    };
    const { cells, gutters } = computeSplitLayout(t);
    expect(cells.map((c) => c.value)).toEqual(["a", "b"]);
    expect(cells[0].rect).toEqual({ left: 0, top: 0, width: 100, height: 70 });
    expect(cells[1].rect).toEqual({ left: 0, top: 70, width: 100, height: 30 });
    expect(gutters).toHaveLength(1);
    expect(gutters[0]).toMatchObject({ splitId: "spl-aaaaaa", dir: "col", index: 0 });
  });

  it("row split = 2 side-by-side cells", () => {
    const t: T = {
      type: "split",
      id: "spl-aaaaaa",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", value: "a" },
        { type: "leaf", value: "b" },
      ],
    };
    const { cells } = computeSplitLayout(t);
    expect(cells[0].rect).toEqual({ left: 0, top: 0, width: 50, height: 100 });
    expect(cells[1].rect).toEqual({ left: 50, top: 0, width: 50, height: 100 });
  });
});

describe("hitTestCells", () => {
  const cells = computeSplitLayout<string>({ type: "leaf", value: "a" }).cells;
  // Container 100x100, header 20, status 0. Body = y[20,100].
  const cr = { left: 0, top: 0, width: 100, height: 100 } as DOMRect;
  const opts = { chromeTop: 20, statusPx: 0 };

  it("body middle = center", () => {
    expect(hitTestCells(50, 60, cr, cells, (v) => v, opts)).toEqual({ id: "a", zone: "center" });
  });
  it("left edge = left", () => {
    expect(hitTestCells(2, 60, cr, cells, (v) => v, opts)).toEqual({ id: "a", zone: "left" });
  });
  it("right edge = right", () => {
    expect(hitTestCells(98, 60, cr, cells, (v) => v, opts)).toEqual({ id: "a", zone: "right" });
  });
  it("top edge inside the body = top", () => {
    // Body [20,100], top ¼ ≈ y<40. y=24.
    expect(hitTestCells(50, 24, cr, cells, (v) => v, opts)).toEqual({ id: "a", zone: "top" });
  });
  it("bottom edge = bottom", () => {
    expect(hitTestCells(50, 96, cr, cells, (v) => v, opts)).toEqual({ id: "a", zone: "bottom" });
  });
  it("header (tab strip) area = center (move)", () => {
    expect(hitTestCells(50, 8, cr, cells, (v) => v, opts)).toEqual({ id: "a", zone: "center" });
  });
  it("selfCenterOnly: the source cell is always center", () => {
    expect(
      hitTestCells(2, 60, cr, cells, (v) => v, { ...opts, sourceId: "a", selfCenterOnly: true }),
    ).toEqual({ id: "a", zone: "center" });
  });
  it("outside every cell = null", () => {
    expect(hitTestCells(200, 200, cr, cells, (v) => v, opts)).toBeNull();
  });
});
