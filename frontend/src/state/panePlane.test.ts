import { SplitPane } from "split-pane";
import { describe, expect, it } from "vitest";
import {
  MIN_PANE_PX, RAIL_CARD, boundaryOf, boundaryShares, centerBoundary, closePane, equalizeAxis,
  flowRailLine, hasRail, moveBoundary, moveBoundaryPx, movePane, paneIds, pullToFront, railLine,
  railStandings, railWidth,
  resizeRail, singlePane, soloPlane, splitPane, standRail, withdrawRail,
  type PlaneBox, type PlaneState,
} from "./panePlane";

const box: PlaneBox = { width: 1000, height: 600, gap: 10 };

const rectsOf = (state: PlaneState) =>
  Object.fromEntries(SplitPane.from(state, { ...box, minSize: MIN_PANE_PX }).rects());


// a | b over c: the arrangement every test below starts from.
function threePanes(): PlaneState {
  const two = splitPane(singlePane("a"), box, "a", "right", "b")!;
  return splitPane(two, box, "b", "bottom", "c")!;
}

describe("the pane plane", () => {
  it("holds one pane on a fresh plane", () => {
    expect(paneIds(singlePane("a"))).toEqual(["a"]);
    expect(rectsOf(singlePane("a")).a).toEqual({ x: 0, y: 0, w: 1000, h: 600 });
  });

  it("reads panes top to bottom, then left to right", () => {
    expect(paneIds(threePanes())).toEqual(["a", "b", "c"]);
  });

  it("refuses a split of a pane that is not there, and a pane id already taken", () => {
    expect(splitPane(singlePane("a"), box, "x", "right", "b")).toBeNull();
    expect(splitPane(singlePane("a"), box, "a", "right", "a")).toBeNull();
  });

  // The floor is what a pane needs to stay a pane: its two chrome bands and two bands of body.
  it("keeps every pane at the floor", () => {
    expect(MIN_PANE_PX).toBe(123);
    let state = singlePane("a");
    let count = 1;
    for (;;) {
      const next = splitPane(state, box, "a", "right", `p${count}`);
      if (next === null) break;
      state = next;
      count++;
    }
    const rects = rectsOf(state);
    for (const id of paneIds(state)) expect(rects[id].w, id).toBeGreaterThanOrEqual(MIN_PANE_PX);
    // The refused split is the one that would have put a half under the floor.
    expect(rects.a.w).toBeLessThan(MIN_PANE_PX * 2 + box.gap);
    expect(count).toBeGreaterThan(1);
  });

  it("closes a pane and lets its neighbours grow over the room", () => {
    const state = closePane(threePanes(), box, "b")!;
    expect(paneIds(state)).toEqual(["a", "c"]);
    const rects = rectsOf(state);
    expect(rects.c.y).toBe(0);
    expect(rects.c.h).toBe(600);
  });

  it("does not close the last pane", () => {
    expect(closePane(singlePane("a"), box, "a")).toBeNull();
  });

  it("moves a pane to a side of another in one operation", () => {
    const state = movePane(threePanes(), box, "a", "c", "bottom")!;
    expect(paneIds(state)).toEqual(["b", "c", "a"]);
    const rects = rectsOf(state);
    expect(rects.b.w).toBe(1000);
    expect(movePane(threePanes(), box, "a", "a", "bottom")).toBeNull();
  });
});

describe("a boundary named by a pane's edge", () => {
  it("is the line that edge stands on, and a border is not one", () => {
    const state = threePanes();
    expect(boundaryOf(state, "a", "right")).toEqual({ axis: "x", line: 1 });
    expect(boundaryOf(state, "b", "left")).toEqual({ axis: "x", line: 1 });
    expect(boundaryOf(state, "b", "bottom")).toEqual({ axis: "y", line: 1 });
    expect(boundaryOf(state, "a", "left")).toBeNull();
    expect(boundaryOf(state, "c", "bottom")).toBeNull();
  });

  it("moves so the slot before it holds the ratio asked for", () => {
    const state = moveBoundary(threePanes(), box, "x", 1, 0.7)!;
    const [before, after] = boundaryShares(state, "x", 1);
    expect(before).toBeCloseTo(0.7, 6);
    expect(after).toBeCloseTo(0.3, 6);
  });

  it("stops at the floor of the pane it would shrink", () => {
    const state = moveBoundary(threePanes(), box, "x", 1, 0.99)!;
    expect(rectsOf(state).b.w).toBeGreaterThanOrEqual(MIN_PANE_PX);
  });

  // split-pane R1: a boundary is one number. Two rows that meet on one line move together, whichever
  // segment is grabbed; a gesture moves a line and never splits it.
  it("moves as one line in every row that meets on it", () => {
    // a | b on top and c | d below, split on the same line.
    const top = splitPane(singlePane("a"), box, "a", "right", "b")!;
    const both = splitPane(splitPane(top, box, "a", "bottom", "c")!, box, "b", "bottom", "d")!;
    expect(rectsOf(both).c.w).toBeCloseTo(rectsOf(both).a.w, 6);
    const moved = moveBoundary(both, box, "x", 1, 0.3)!;
    const rects = rectsOf(moved);
    expect(rects.a.w).toBeCloseTo(rects.c.w, 6);
    expect(rects.b.x).toBeCloseTo(rects.d.x, 6);
    expect(boundaryShares(moved, "x", 1)[0]).toBeCloseTo(0.3, 6);
  });

  it("centres between its neighbours", () => {
    const moved = moveBoundary(threePanes(), box, "x", 1, 0.7)!;
    expect(boundaryShares(centerBoundary(moved, box, "x", 1)!, "x", 1)).toEqual([0.5, 0.5]);
  });

  it("spaces every boundary on an axis evenly", () => {
    const two = splitPane(singlePane("a"), box, "a", "right", "b")!;
    const three = moveBoundary(splitPane(two, box, "b", "right", "c")!, box, "x", 1, 0.2)!;
    const even = equalizeAxis(three, box, "x");
    const rects = rectsOf(even);
    expect(rects.a.w).toBeCloseTo(rects.b.w, 6);
    expect(rects.b.w).toBeCloseTo(rects.c.w, 6);
    expect(rects.a.w).toBeCloseTo((1000 - 2 * box.gap) / 3, 6);
  });

  it("leaves the rail its width when the panes are evened", () => {
    const two = splitPane(singlePane("a"), box, "a", "right", "b")!;
    const withRail = standRail(moveBoundary(two, box, "x", 1, 0.8)!, box, 1, 190)!;
    const rects = rectsOf(equalizeAxis(withRail, box, "x"));
    expect(rects.rail.w).toBeCloseTo(190, 6);
    expect(rects.a.w).toBeCloseTo(rects.b.w, 6);
    expect(rects.a.w).toBeCloseTo((1000 - 190 - 2 * box.gap) / 2, 6);
  });
});

describe("the rail on the plane", () => {
  it("can stand on every vertical line no pane spans across", () => {
    expect(railStandings(threePanes(), box)).toEqual([0, 1, 2]);
    const tall = splitPane(singlePane("a"), box, "a", "bottom", "b")!;
    const wide = splitPane(tall, box, "b", "right", "c")!;
    // a spans the whole width above b|c, so the line between b and c is crossed; the borders stand.
    expect(railStandings(wide, box)).toEqual([0, 2]);
  });

  // SIDEBAR S2: FLOW stands the rail on the focused pane's left line; blocked, the nearest one in
  // front of it. A rail beside the pane is on its own line already.
  it("has a line for the focused pane in FLOW", () => {
    const state = threePanes();
    expect(flowRailLine(state, box, "a")).toBe(0);
    expect(flowRailLine(state, box, "b")).toBe(1);
    // A rail beside the pane is on its own line already: standing it there again changes nothing.
    const standing = standRail(state, box, 1, 190)!;
    expect(standRail(standing, box, flowRailLine(standing, box, "b")!, 190)).toEqual(standing);
    expect(flowRailLine(standing, box, "a")).toBe(0);
    const tall = splitPane(singlePane("a"), box, "a", "bottom", "d")!;
    const blocked = splitPane(tall, box, "a", "right", "b")!;
    expect(flowRailLine(blocked, box, "b")).toBe(0);
    expect(flowRailLine(blocked, box, "x")).toBeNull();
  });

  it("stands at its declared width and is fixed", () => {
    const state = standRail(threePanes(), box, 1, 190)!;
    expect(hasRail(state)).toBe(true);
    expect(railLine(state)).toBe(1);
    expect(state.cards.find((c) => c.id === RAIL_CARD)).toMatchObject({ fixed: true });
    expect(railWidth(state)).toBe(190);
    expect(rectsOf(state).rail.w).toBeCloseTo(190, 6);
    expect(paneIds(state)).toEqual(["a", "b", "c"]);
  });

  it("moves to another line when it already stands", () => {
    const at1 = standRail(threePanes(), box, 1, 190)!;
    const at0 = standRail(at1, box, 0, 190)!;
    expect(railLine(at0)).toBe(0);
    expect(rectsOf(at0).rail.x).toBe(0);
    expect(rectsOf(at0).rail.w).toBeCloseTo(190, 6);
  });

  // split-pane R5: beside a card with a declared width, a drag changes that width and the slot on
  // the other side pays for it — so the rail's right grip keeps its left edge where it is.
  it("keeps its left edge when its right boundary is dragged", () => {
    const standing = standRail(threePanes(), box, 1, 190)!;
    const before = rectsOf(standing);
    const rail = standing.cards.find((c) => c.id === RAIL_CARD)!;
    // A boundary is in the middle of the corridor: half a gap past the rail's right edge.
    const dragged = moveBoundaryPx(standing, box, "x", rail.c1, before.rail.x + before.rail.w + box.gap / 2 + 60)!;
    const after = rectsOf(dragged);
    expect(after.rail.x).toBeCloseTo(before.rail.x, 6);
    expect(after.rail.w).toBeCloseTo(250, 6);
    expect(railWidth(dragged)).toBeCloseTo(250, 6);
    expect(after.a.w).toBeCloseTo(before.a.w, 6);
    expect(after.b.w).toBeCloseTo(before.b.w - 60, 6);
  });

  it("takes a new width in place", () => {
    const state = resizeRail(standRail(threePanes(), box, 1, 190)!, box, 240);
    expect(rectsOf(state).rail.w).toBeCloseTo(240, 6);
    expect(resizeRail(threePanes(), box, 240)).toEqual(threePanes());
  });

  // The library's R5: a card that leaves gives its room back to the slot it took it from.
  it("gives the panes their widths back when it withdraws from where it stood", () => {
    const before = rectsOf(threePanes());
    const after = rectsOf(withdrawRail(standRail(threePanes(), box, 1, 190)!, box));
    for (const id of ["a", "b", "c"]) {
      expect(after[id].w, id).toBeCloseTo(before[id].w, 6);
    }
    expect(hasRail(withdrawRail(threePanes(), box))).toBe(false);
  });

  // A withdraw that grew a neighbour over the rail's slot left the slot's line on the plane with
  // no card on it; the next stand landed beside it, and the lines grew by one per cycle.
  it("leaves no line behind when it withdraws", () => {
    const stood = standRail(threePanes(), box, 1, 190)!;
    const gone = withdrawRail(stood, box);
    expect(gone.xs).toHaveLength(threePanes().xs.length);
    const again = standRail(gone, box, 0, 190)!;
    expect(again.xs).toHaveLength(threePanes().xs.length + 1);
  });

  it("leaves no line behind when a pane closes", () => {
    // c grows over b: the line between a and c stays, the one between b and c has no card on it.
    const state = closePane(threePanes(), box, "b")!;
    expect(state.xs).toHaveLength(3);
    expect(state.ys).toHaveLength(2);
  });
});

describe("a focused pane the rail cannot reach", () => {
  // a | b on top, c across the bottom: the line between a and b is crossed, so the rail cannot
  // stand at b's left. Pulled to the front, b stands first and a follows it, each at its own width.
  function blockedRow(): PlaneState {
    const tall = splitPane(singlePane("a"), box, "a", "bottom", "c")!;
    return moveBoundary(splitPane(tall, box, "a", "right", "b")!, box, "x", 1, 0.3)!;
  }

  it("changes places with the pane at its left, each at its own width", () => {
    const before = rectsOf(blockedRow());
    const pulled = pullToFront(blockedRow(), box, "b");
    const after = rectsOf(pulled);
    expect(paneIds(pulled)).toEqual(["b", "a", "c"]);
    expect(after.b.x).toBe(0);
    expect(after.b.w).toBeCloseTo(before.b.w, 6);
    expect(after.a.w).toBeCloseTo(before.a.w, 6);
    expect(after.c.w).toBe(1000);
    expect(railStandings(pulled, box)).toContain(0);
  });

  it("is left where it is when its left line already stands", () => {
    const state = threePanes();
    expect(pullToFront(state, box, "b")).toBe(state);
    expect(pullToFront(state, box, "a")).toBe(state);
  });

  // a | b | c on top, d across the bottom. Focusing c: the exchange with b is the nearest, and it
  // does not free c's left line (still crossed by d), so c changes places with a; b keeps its
  // width between them.
  it("takes the nearest exchange that frees its line", () => {
    const tall = splitPane(singlePane("a"), box, "a", "bottom", "d")!;
    const row = splitPane(splitPane(tall, box, "a", "right", "b")!, box, "b", "right", "c")!;
    const before = rectsOf(row);
    const pulled = pullToFront(row, box, "c");
    const after = rectsOf(pulled);
    expect(paneIds(pulled)).toEqual(["c", "b", "a", "d"]);
    expect(after.c.x).toBe(0);
    for (const id of ["a", "b", "c", "d"]) expect(after[id].w, id).toBeCloseTo(before[id].w, 6);
  });
});

describe("a space showing one pane", () => {
  it("is a plane of that pane alone", () => {
    const solo = soloPlane(threePanes(), "b");
    expect(paneIds(solo)).toEqual(["b"]);
    expect(rectsOf(solo).b).toEqual({ x: 0, y: 0, w: 1000, h: 600 });
  });

  it("keeps the rail beside it, on the side it stood on", () => {
    const standing = standRail(threePanes(), box, 1, 190)!;
    const right = soloPlane(standing, "b");
    expect(railLine(right)).toBe(0);
    const rects = rectsOf(right);
    expect(rects.rail.w).toBeCloseTo(190, 6);
    expect(rects.b.x).toBeCloseTo(200, 6);
    expect(rects.b.w).toBeCloseTo(800, 6);
    // a stood left of the rail: shown alone, the rail is at its right.
    const left = rectsOf(soloPlane(standing, "a"));
    expect(left.a.x).toBe(0);
    expect(left.a.w).toBeCloseTo(800, 6);
    expect(left.rail.x).toBeCloseTo(810, 6);
  });
});
