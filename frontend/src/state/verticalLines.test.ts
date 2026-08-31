import { describe, it, expect } from "vitest";
import { computeSplitLayout } from "../lib/splitLayout";
import { cleanRailLines } from "../lib/railPlacement";
import { resizeSplitTree, splitLeaf, type SplitTree } from "./splitTree";
import {
  LINE_GROUP_EPS,
  LINE_SNAP_EPS,
  MIN_PANE_FRAC,
  minPaneFracForSpan,
  collectLineGroup,
  equalizeLineGroup,
  lineGroupRange,
  moveLineGroup,
  normalizeVerticalLines,
} from "./verticalLines";

describe("minimum pane fraction", () => {
  it("keeps the body positive when a split is shorter than its fixed chrome", () => {
    // Content header + status is 57px. At a 30.8px split span, the old 8%
    // clamp produced a pane with no native viewport at all.
    expect(minPaneFracForSpan(30.8, 57)).toBeCloseTo(0.5, 10);
  });

  it("keeps the established base fraction when the split is tall enough", () => {
    expect(minPaneFracForSpan(1000, 57)).toBe(MIN_PANE_FRAC);
  });
});

// Vertical no-split proposition — a clean vertical line has one identity across the full height.
// Dragging any segment moves the whole line, and a drag can move a line but never split it.
// These tests pin the pure logic with L=string (group collection, intersection clamp, move, restore normalization).

function split<L>(
  id: string,
  dir: "row" | "col",
  sizes: number[],
  children: SplitTree<L>[],
): SplitTree<L> {
  return { type: "split", id, dir, sizes, children };
}

const leaf = (v: string): SplitTree<string> => splitLeaf(v);

// col[top row, bottom row] — the minimal fixture where a vertical line splits into a top and a bottom segment.
const stacked = (topSizes: number[], botSizes: number[]): SplitTree<string> =>
  split("c", "col", [0.5, 0.5], [
    split("top", "row", topSizes, [leaf("a"), leaf("b")]),
    split("bot", "row", botSizes, [leaf("d"), leaf("e")]),
  ]);

const rowDividersOf = <L,>(tree: SplitTree<L>) =>
  computeSplitLayout(tree).gutters.filter((d) => d.dir === "row");

const applyMoves = (
  tree: SplitTree<string>,
  moves: { splitId: string; sizes: number[] }[],
) => moves.reduce((acc, m) => resizeSplitTree(acc, m.splitId, m.sizes), tree);

const rowXAt = (tree: SplitTree<string>, splitId: string, index: number) =>
  rowDividersOf(tree).find((d) => d.splitId === splitId && d.index === index)!
    .rect.left;

describe("collectLineGroup — the line group at drag start", () => {
  it("top and bottom segments at the same x form one group (ascending by top)", () => {
    const { gutters } = computeSplitLayout(stacked([0.4, 0.6], [0.4, 0.6]));
    const group = collectLineGroup(gutters, "top", 0);
    expect(group.map((d) => d.splitId)).toEqual(["top", "bot"]);
    // Dragging the bottom segment gives the same group — any segment means the whole line.
    const fromBot = collectLineGroup(gutters, "bot", 0);
    expect(fromBot.map((d) => d.splitId)).toEqual(["top", "bot"]);
  });

  it("within the tolerance (0.6) segments group, outside it (1.1) they do not", () => {
    const near = computeSplitLayout(stacked([0.406, 0.594], [0.4, 0.6])).gutters;
    expect(collectLineGroup(near, "top", 0)).toHaveLength(2);
    const far = computeSplitLayout(stacked([0.406, 0.594], [0.395, 0.605])).gutters;
    expect(
      collectLineGroup(far, "top", 0, LINE_GROUP_EPS).map((d) => d.splitId),
    ).toEqual(["top"]);
  });

  it("a col divider does not enter the group", () => {
    const tree = split("r", "row", [0.4, 0.6], [
      leaf("a"),
      split("c", "col", [0.5, 0.5], [leaf("b"), leaf("d")]),
    ]);
    const { gutters } = computeSplitLayout(tree);
    const group = collectLineGroup(gutters, "r", 0);
    expect(group.every((d) => d.dir === "row")).toBe(true);
    expect(group).toHaveLength(1);
  });

  it("side-by-side dividers sharing the same y span (the same split) are not one line", () => {
    const tree = split("r", "row", [0.4, 0.006, 0.594], [
      leaf("a"),
      leaf("b"),
      leaf("d"),
    ]);
    const { gutters } = computeSplitLayout(tree);
    // 40 and 40.6 — x is inside the tolerance, but both span the full height (same y), so they are separate parallel lines.
    expect(collectLineGroup(gutters, "r", 0)).toHaveLength(1);
  });

  it("a segment that cannot move to the anchor x is not grouped — with the only companion candidate blocked, the anchor stands alone", () => {
    // The bottom segment's right neighbor is exactly minFrac — it cannot move one step right of 92.0.
    // Grouping the anchor (92.5) drops the intersection cap (92.0) below the start x, so the clamp pulls the start point.
    const { gutters } = computeSplitLayout(stacked([0.925, 0.075], [0.92, 0.08]));
    expect(collectLineGroup(gutters, "top", 0).map((d) => d.splitId)).toEqual([
      "top",
    ]);
  });

  it("a degenerate case where only some cannot move falls back to the largest valid subset — the two segments at 92.5 move together", () => {
    // Only the bottom segment (92.0) has a right neighbor exactly at minFrac, so it cannot come to the anchor x (92.5).
    // That segment alone drops out and the two 92.5 segments must stay one group and move together —
    // falling back to the anchor alone lets a drag tear the 92.5 line that shares one x.
    const tree = split("c", "col", [0.34, 0.33, 0.33], [
      split("r0", "row", [0.925, 0.075], [leaf("a"), leaf("b")]),
      split("r1", "row", [0.925, 0.075], [leaf("d"), leaf("e")]),
      split("r2", "row", [0.92, 0.08], [leaf("f"), leaf("g")]),
    ]);
    const { gutters } = computeSplitLayout(tree);
    const group = collectLineGroup(gutters, "r0", 0);
    expect(group.map((d) => d.splitId)).toEqual(["r0", "r1"]);
    const next = applyMoves(tree, moveLineGroup(group, 90).moves);
    expect(rowXAt(next, "r0", 0)).toBeCloseTo(90, 10);
    expect(rowXAt(next, "r1", 0)).toBeCloseTo(90, 10);
    expect(rowXAt(next, "r2", 0)).toBeCloseTo(92, 10); // a segment that cannot move stays in place
  });
});

describe("lineGroupRange — the intersection of the allowed x ranges", () => {
  it("a single segment gives the minFrac clamp range", () => {
    const { gutters } = computeSplitLayout(
      split("r", "row", [0.4, 0.6], [leaf("a"), leaf("b")]),
    );
    const range = lineGroupRange(gutters);
    expect(range.min).toBeCloseTo(40 - (0.4 - MIN_PANE_FRAC) * 100, 10);
    expect(range.max).toBeCloseTo(40 + (0.6 - MIN_PANE_FRAC) * 100, 10);
  });

  it("a group gives the intersection of each segment's range", () => {
    // Top: [8, 92], bottom: right neighbor 0.1 -> cap 40 + (0.1-0.08)*100 = 42.
    const { gutters } = computeSplitLayout(
      split("c", "col", [0.5, 0.5], [
        split("top", "row", [0.4, 0.6], [leaf("a"), leaf("b")]),
        split("bot", "row", [0.4, 0.1, 0.5], [leaf("d"), leaf("e"), leaf("f")]),
      ]),
    );
    const group = collectLineGroup(gutters, "top", 0);
    expect(group).toHaveLength(2);
    const range = lineGroupRange(group);
    expect(range.min).toBeCloseTo(8, 10);
    expect(range.max).toBeCloseTo(42, 10);
  });

  it("a neighbor already below minFrac makes the current x the bound — the range always includes the starting x", () => {
    const { gutters } = computeSplitLayout(
      split("r", "row", [0.05, 0.95], [leaf("a"), leaf("b")]),
    );
    const range = lineGroupRange(gutters);
    expect(range.min).toBeCloseTo(5, 10);
    expect(range.min).toBeLessThanOrEqual(range.max);
  });
});

describe("moveLineGroup — the whole group to the same x", () => {
  it("after applying, both segments are exactly at target and the sizes sum is preserved", () => {
    const tree = stacked([0.4, 0.6], [0.4, 0.6]);
    const { gutters } = computeSplitLayout(tree);
    const group = collectLineGroup(gutters, "top", 0);
    const { x, moves } = moveLineGroup(group, 55);
    expect(x).toBe(55);
    expect(moves).toHaveLength(2);
    const next = applyMoves(tree, moves);
    for (const d of rowDividersOf(next)) expect(d.rect.left).toBeCloseTo(55, 10);
    for (const m of moves)
      expect(m.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("a target outside the intersection is clamped to the bound", () => {
    const tree = stacked([0.4, 0.6], [0.4, 0.6]);
    const group = collectLineGroup(computeSplitLayout(tree).gutters, "top", 0);
    const { x, moves } = moveLineGroup(group, 99);
    expect(x).toBeCloseTo(92, 10);
    const next = applyMoves(tree, moves);
    for (const d of rowDividersOf(next)) expect(d.rect.left).toBeCloseTo(92, 10);
  });

  it("a group misaligned within the tolerance joins one x on drag (healing)", () => {
    const tree = stacked([0.406, 0.594], [0.402, 0.598]);
    const group = collectLineGroup(computeSplitLayout(tree).gutters, "top", 0);
    expect(group).toHaveLength(2);
    const { moves } = moveLineGroup(group, 50);
    const next = applyMoves(tree, moves);
    for (const d of rowDividersOf(next)) expect(d.rect.left).toBeCloseTo(50, 10);
  });

  it("an empty group moves nothing", () => {
    expect(moveLineGroup([], 50).moves).toEqual([]);
  });
});

describe("equalizeLineGroup — double-click equalize takes the line group path too", () => {
  it("double-clicking the top segment at top 0.4/0.6 and bottom 0.4/0.6 puts both lines at 50 (no tearing)", () => {
    const tree = stacked([0.4, 0.6], [0.4, 0.6]);
    const { x, moves } = equalizeLineGroup(
      computeSplitLayout(tree).gutters,
      "top",
      0,
    );
    expect(x).toBeCloseTo(50, 10);
    expect(moves).toHaveLength(2);
    const next = applyMoves(tree, moves);
    for (const d of rowDividersOf(next)) expect(d.rect.left).toBeCloseTo(50, 10);
  });

  it("an equalize target outside the intersection is clamped — the group stops together at the same x", () => {
    // Bottom middle panel 0.1 -> group cap 42. The equalize target 50 clamps to 42 and both segments
    // stand together at 42 (line integrity outranks an exact half-and-half).
    const tree = split("c", "col", [0.5, 0.5], [
      split("top", "row", [0.4, 0.6], [leaf("a"), leaf("b")]),
      split("bot", "row", [0.4, 0.1, 0.5], [leaf("d"), leaf("e"), leaf("f")]),
    ]);
    const { x, moves } = equalizeLineGroup(
      computeSplitLayout(tree).gutters,
      "top",
      0,
    );
    expect(x).toBeCloseTo(42, 10);
    const next = applyMoves(tree, moves);
    expect(rowXAt(next, "top", 0)).toBeCloseTo(42, 10);
    expect(rowXAt(next, "bot", 0)).toBeCloseTo(42, 10);
    expect(rowXAt(next, "bot", 1)).toBeCloseTo(50, 10); // a divider outside the group is unchanged
  });

  it("no anchor moves nothing", () => {
    expect(equalizeLineGroup([], "nope", 0).moves).toEqual([]);
  });
});

describe("normalizeVerticalLines — one normalization on restore (self-healing)", () => {
  it("a polluted line (40.6/39.5) is unified at the topmost segment's x — the clean line is restored", () => {
    const torn = stacked([0.406, 0.594], [0.395, 0.605]);
    // Defect site: a torn line produces no full-height vertical line at all (every FLOW rail gone).
    expect(
      cleanRailLines(computeSplitLayout(torn).cells.map((c) => c.rect)),
    ).toEqual([0, 100]);

    const healed = normalizeVerticalLines(torn);
    for (const d of rowDividersOf(healed)) expect(d.rect.left).toBeCloseTo(40.6, 10);
    const lines = cleanRailLines(
      computeSplitLayout(healed).cells.map((c) => c.rect),
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBeCloseTo(40.6, 10);
  });

  it("a misalignment beyond the tolerance (1.5) is a different line and is left untouched (the original reference is returned)", () => {
    const separate = stacked([0.406, 0.594], [0.389, 0.611]);
    expect(normalizeVerticalLines(separate, LINE_SNAP_EPS)).toBe(separate);
  });

  it("idempotent — an already aligned tree comes back as the original reference", () => {
    const aligned = stacked([0.4, 0.6], [0.4, 0.6]);
    expect(normalizeVerticalLines(aligned)).toBe(aligned);
    const healed = normalizeVerticalLines(stacked([0.406, 0.594], [0.395, 0.605]));
    expect(normalizeVerticalLines(healed)).toBe(healed);
  });

  it("a snap that would shrink a pane below minFrac holds that segment back", () => {
    // Pushing the bottom segment 39.5->40.6 shrinks the middle panel 0.085->0.074 (<0.08) — held back.
    const tree = split("c", "col", [0.5, 0.5], [
      split("top", "row", [0.406, 0.594], [leaf("a"), leaf("b")]),
      split("bot", "row", [0.395, 0.085, 0.52], [leaf("d"), leaf("e"), leaf("f")]),
    ]);
    expect(normalizeVerticalLines(tree)).toBe(tree);
  });

  it("a horizontal (col) line is outside the proposition — a misalignment there is left untouched", () => {
    const horizontal = split("r", "row", [0.5, 0.5], [
      split("lc", "col", [0.406, 0.594], [leaf("a"), leaf("b")]),
      split("rc", "col", [0.395, 0.605], [leaf("d"), leaf("e")]),
    ]);
    expect(normalizeVerticalLines(horizontal)).toBe(horizontal);
  });

  it("even when an ancestor line's snap pushes a descendant line, both lines settle exactly", () => {
    // Line 1 = rowT (31) on top, rowB (30) below — the anchor (topmost) is 31, so rowB moves.
    // Line 2 (65/65.7) is inside rowB's right child — the rowB snap pushes line 2 as a whole, but
    // ancestor-first application plus a recompute before each application lands line 2 exactly on its original anchor x (65).
    const tree = split("root", "col", [0.5, 0.5], [
      split("rowT", "row", [0.31, 0.69], [leaf("a"), leaf("b")]),
      split("rowB", "row", [0.3, 0.7], [
        leaf("d"),
        split("inner", "col", [0.5, 0.5], [
          split("rowA", "row", [0.5, 0.5], [leaf("e"), leaf("f")]),
          split("rowC", "row", [0.51, 0.49], [leaf("g"), leaf("h")]),
        ]),
      ]),
    ]);
    const healed = normalizeVerticalLines(tree);
    const at = (id: string) =>
      rowDividersOf(healed).find((d) => d.splitId === id)!.rect.left;
    expect(at("rowT")).toBeCloseTo(31, 10);
    expect(at("rowB")).toBeCloseTo(31, 10);
    expect(at("rowA")).toBeCloseTo(65, 10);
    expect(at("rowC")).toBeCloseTo(65, 10);
  });
});
