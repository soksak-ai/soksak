import { describe, it, expect } from "vitest";

import {
  moveBoundary, rectsOf, splitPane, standRail, type PlaneBox, type PlaneState,
} from "./panePlane";
import { columnPlane, planeOf, rowPlane } from "../test/planes";

// The layout contract, as propositions a machine can settle.
//
// Each one states what must be true of a laid-out plane, and each is settled by a measurement
// rather than by looking at the screen. A capture can show that something is wrong; only a
// number here can say a change fixed it and keeps it fixed.
//
// See docs/tech/UI-GEOMETRY.md and docs/tech/PANE-PLANE.md for the rules these enforce.

const box: PlaneBox = { width: 1000, height: 600, gap: 0 };

/** Two stacked rows, each split left/right — on the plane, on one line (split-pane R1). */
const stacked = (): PlaneState => {
  const top = rowPlane(["top-left", "top-right"]);
  const both = splitPane(top, box, "top-left", "bottom", "bottom-left")!;
  return splitPane(both, box, "top-right", "bottom", "bottom-right")!;
};

describe("V1 — a vertical line has one x", () => {
  it("segments two rows meet on stand at the same x, and cannot be told apart", () => {
    const plane = stacked();
    const rects = rectsOf(plane, box);
    expect(rects.get("top-right")!.x).toBe(rects.get("bottom-right")!.x);
    // The line is one index on the plane: both right-hand panes start at it.
    const line = plane.cards.find((c) => c.id === "top-right")!.c0;
    expect(plane.cards.find((c) => c.id === "bottom-right")!.c0).toBe(line);
  });

  it("a drag on either row moves the line for both", () => {
    const moved = moveBoundary(stacked(), box, "x", 1, 0.3)!;
    const rects = rectsOf(moved, box);
    expect(rects.get("top-right")!.x).toBe(300);
    expect(rects.get("bottom-right")!.x).toBe(300);
  });

  it("there is no tolerance to judge by — two places are one line or they are two", () => {
    // A nearly aligned pair is a state the tree could reach and the plane cannot: the second
    // row's split snaps to the line the first row made (split-pane R1, "a later split snaps to it").
    const plane = stacked();
    expect(plane.xs).toHaveLength(3);
  });
});

describe("V2/V3 — cells tile the plane", () => {
  // Built inside the test: the fixtures lay out in the plane box the test environment sets.
  const shapes: [string, () => PlaneState][] = [
    ["one pane", () => rowPlane(["only"])],
    ["two columns", () => moveBoundary(rowPlane(["a", "b"]), box, "x", 1, 0.28)!],
    ["stacked", stacked],
    ["uneven", () => planeOf("a", { id: "d", side: "right", of: "a" }, { id: "b", side: "right", of: "a" }, { id: "c", side: "bottom", of: "b" })],
    ["with the rail", () => standRail(columnPlane(["a", "b"]), box, 0, 120)!],
  ];

  it.each(shapes)("%s covers the plane with no overlap", (_name, build) => {
    const rects = [...rectsOf(build(), box).values()];
    const area = rects.reduce((n, r) => n + r.w * r.h, 0);
    expect(area).toBeCloseTo(box.width * box.height, 6);

    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const apart =
          b.x >= a.x + a.w - 1e-9 ||
          a.x >= b.x + b.w - 1e-9 ||
          b.y >= a.y + a.h - 1e-9 ||
          a.y >= b.y + b.h - 1e-9;
        expect(apart).toBe(true);
      }
    }
  });

  // split-pane R5: the corridor is half a gap on every inner edge and nothing at the border, so the
  // cards and the corridors between them cover the plane exactly.
  it("with a corridor, the cards and the corridors cover the plane exactly", () => {
    const withGap: PlaneBox = { ...box, gap: 10 };
    const rects = [...rectsOf(stacked(), withGap).values()];
    const cardArea = rects.reduce((n, r) => n + r.w * r.h, 0);
    // One vertical corridor the full height, one horizontal the full width, overlapping once.
    const corridors = 10 * box.height + 10 * box.width - 10 * 10;
    expect(cardArea + corridors).toBeCloseTo(box.width * box.height, 6);
    expect(Math.min(...rects.map((r) => r.x))).toBe(0);
    expect(Math.max(...rects.map((r) => r.x + r.w))).toBe(box.width);
  });
});
