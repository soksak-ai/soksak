import { describe, it, expect } from "vitest";

import { computeSplitLayout } from "../lib/splitLayout";
import { collectLineGroup, LINE_GROUP_EPS } from "./verticalLines";
import type { SplitTree } from "./splitTree";

// The layout contract, as propositions a machine can settle.
//
// These are the numbers the split-pane migration has to move. Each one says what must
// be true of a rendered layout, and each is decided by a measurement rather than by
// looking at the screen. A capture can show that something is wrong; only a number
// here can say a change fixed it and keeps it fixed.
//
// See docs/tech/UI-GEOMETRY.md for the rules these enforce.

type Leaf = { id: string };

const leaf = (id: string): SplitTree<Leaf> => ({ type: "leaf", value: { id } });
const split = (
  id: string,
  dir: "row" | "col",
  sizes: number[],
  children: SplitTree<Leaf>[],
): SplitTree<Leaf> => ({ type: "split", id, dir, sizes, children });

/**
 * Two stacked rows, each split left/right at very nearly — but not exactly — the same x.
 *
 * `LINE_SNAP_EPS` exists to heal exactly this shape when it is restored from an old
 * snapshot, so it is a state the product knows how to arrive at. A drag reaches it too:
 * `collectLineGroup` drops a segment whose neighbour is already at minimum width, moves
 * the rest, and leaves that one behind at its own x.
 */
const nearlyAligned = (a: number, b: number) =>
  split("root", "col", [0.5, 0.5], [
    split("top", "row", [a, 1 - a], [leaf("top-left"), leaf("top-right")]),
    split("bottom", "row", [b, 1 - b], [leaf("bottom-left"), leaf("bottom-right")]),
  ]);

const assertClose = (a: number, b: number, why: string) => {
  expect(Math.abs(a - b), why).toBeLessThan(1e-9);
};

describe("V1 — a vertical line has one x", () => {
  it("segments the layout itself calls one line stand at the same x", () => {
    const tree = nearlyAligned(0.3, 0.304);
    const { gutters } = computeSplitLayout(tree);

    // Ask the layout which segments form one line, using its own rule rather than ours.
    const group = collectLineGroup(gutters, "top", 0);
    expect(group.length).toBe(2);

    const xs = group.map((d) => d.rect.left);
    const drift = Math.max(...xs) - Math.min(...xs);

    // A line is one thing. Segments that are one line are in one place, and no tolerance
    // makes two places into one.
    expect(drift).toBe(0);
  });

  it("a segment that cannot come to the shared x is left where it stands", () => {
    // The bottom segment's right neighbour is exactly the minimum, so it cannot
    // move right of 92. Settling it onto the other two would draw a pane
    // smaller than a pane may be, so it stays — and is a different line, which
    // is what it is.
    const tree = split("root", "col", [0.34, 0.33, 0.33], [
      split("r0", "row", [0.925, 0.075], [leaf("a"), leaf("b")]),
      split("r1", "row", [0.925, 0.075], [leaf("c"), leaf("d")]),
      split("r2", "row", [0.92, 0.08], [leaf("e"), leaf("f")]),
    ]);
    const rows = computeSplitLayout(tree).gutters.filter((d) => d.dir === "row");
    const at = (id: string) => rows.find((d) => d.splitId === id)!.rect.left;

    assertClose(at("r0"), at("r1"), "the two that can be one line are");
    expect(at("r2")).toBeCloseTo(92, 10);
    expect(Math.abs(at("r2") - at("r0"))).toBeGreaterThan(0.4);

    // And the layout does not call it one of them.
    const group = collectLineGroup(computeSplitLayout(tree).gutters, "r0", 0);
    expect(group.map((d) => d.splitId).sort()).toEqual(["r0", "r1"]);
  });

  it("the grouping tolerance is what lets two places be called one line", () => {
    // Inside the tolerance the layout says "one line" while the segments are 0.4 apart.
    const together = computeSplitLayout(nearlyAligned(0.3, 0.304));
    expect(collectLineGroup(together.gutters, "top", 0)).toHaveLength(2);

    // Outside it the same shape is two lines. The only thing that changed is a number.
    const apart = computeSplitLayout(nearlyAligned(0.3, 0.3 + (LINE_GROUP_EPS + 0.25) / 100));
    expect(collectLineGroup(apart.gutters, "top", 0)).toHaveLength(1);
  });
});

describe("V2/V3 — cells tile the plane", () => {
  const shapes: [string, SplitTree<Leaf>][] = [
    ["one leaf", leaf("only")],
    ["two columns", split("r", "row", [0.28, 0.72], [leaf("a"), leaf("b")])],
    ["nested", nearlyAligned(0.3, 0.304)],
    [
      "uneven",
      split("r", "row", [0.2, 0.5, 0.3], [
        leaf("a"),
        split("c", "col", [0.4, 0.6], [leaf("b"), leaf("c")]),
        leaf("d"),
      ]),
    ],
  ];

  it.each(shapes)("%s covers 100%% with no overlap", (_name, tree) => {
    const { cells } = computeSplitLayout(tree);
    const area = cells.reduce((n, c) => n + c.rect.width * c.rect.height, 0);
    expect(area).toBeCloseTo(100 * 100, 6);

    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i].rect;
        const b = cells[j].rect;
        const apart =
          b.left >= a.left + a.width - 1e-9 ||
          a.left >= b.left + b.width - 1e-9 ||
          b.top >= a.top + a.height - 1e-9 ||
          a.top >= b.top + b.height - 1e-9;
        expect(apart).toBe(true);
      }
    }
  });
});
