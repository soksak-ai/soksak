import { describe, expect, it } from "vitest";
import {
  arrangementMoves, presentedRailWidth, projectionGeometryChanged, railBoundBox,
  resolveEffectiveRailRelation, resolvePresentedRailRelation, solveArrangement, viewIdsOfMoves,
  type Arrangement,
} from "./railArrangement";
import {
  flowRailLine, moveBoundary, splitPane, standRail, type PlaneBox, type PlaneState,
} from "../state/panePlane";
import { columnPlane, planeOf, rowPlane } from "../test/planes";

// A plane of 1000×600 with no corridor: every number below is a whole px.
const box: PlaneBox = { width: 1000, height: 600, gap: 0 };
const RAIL_W = 100;

const pane = (id: string) => ({ id, activeTabId: `${id}-tab`, tabs: [{ id: `${id}-tab` }] });

const solve = (
  layout: PlaneState,
  focusId: string | null,
  extra: Partial<Parameters<typeof solveArrangement>[0]> = {},
): Arrangement =>
  solveArrangement({
    layout, box, focusId, placement: { mode: "flow" }, railPresent: true, ...extra,
  });

const rectOf = (a: Arrangement, id: string) => a.cells.find((c) => c.id === id)!.rect;

describe("arrangement solver — what the screen draws is a function of the plane and the focus", () => {
  it("detects station, membership and rect changes even when no pane translates", () => {
    const base = solve(rowPlane(["a", "b"]), "a", { railPresent: false });
    expect(projectionGeometryChanged(base, base)).toBe(false);
    const withRail = solve(standRail(rowPlane(["a", "b"]), box, 0, RAIL_W)!, "a");
    expect(projectionGeometryChanged(base, withRail)).toBe(true);
    const widened = solve(moveBoundary(rowPlane(["a", "b"]), box, "x", 1, 0.7)!, "a", { railPresent: false });
    expect(projectionGeometryChanged(base, widened)).toBe(true);
    const fewer = solve(rowPlane(["a"]), "a", { railPresent: false });
    expect(projectionGeometryChanged(base, fewer)).toBe(true);
  });

  // The rail's line is the plane's: the solver reads where it stands, in px.
  it("reads the station from the plane, and the lines it could stand on", () => {
    const layout = standRail(rowPlane(["a", "b", "c"]), box, 1, RAIL_W)!;
    const solved = solve(layout, "b");
    expect(solved.railPresent).toBe(true);
    // a | b | c is a halved, then b halved: the line after a is at 500.
    expect(solved.rail).toMatchObject({ left: 500, width: RAIL_W });
    expect(solved.station).toBe(500);
    // Five lines: the borders, the rail's two, and the one between b and c.
    expect(solved.cleanLines).toEqual([0, 500, 600, 750, 1000]);
    expect(solved.standingLines).toEqual([0, 1, 2, 3, 4]);
    expect(solved.cells.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("draws no rail when no set stands in it, whatever the plane holds", () => {
    const layout = standRail(rowPlane(["a", "b"]), box, 1, RAIL_W)!;
    const solved = solve(layout, "b", { railPresent: false });
    expect(solved.railPresent).toBe(false);
    expect(solved.rail).toBeNull();
    expect(solved.station).toBe(0);
    expect(rectOf(solved, "a")).toEqual({ left: 0, top: 0, width: 500, height: 600 });
    expect(rectOf(solved, "b")).toEqual({ left: 500, top: 0, width: 500, height: 600 });
    expect(solved.dividers).toHaveLength(1);
  });

  it("shows a maximized pane alone with the rail at its left, and no divider", () => {
    const layout = standRail(rowPlane(["a", "b"]), box, 1, RAIL_W)!;
    const solved = solve(layout, "b", { maximizedId: "b" });
    expect(solved.maximizedId).toBe("b");
    expect(solved.cells.map((c) => c.id)).toEqual(["b"]);
    expect(solved.rail).toMatchObject({ left: 0, width: RAIL_W });
    expect(rectOf(solved, "b")).toEqual({ left: RAIL_W, top: 0, width: 1000 - RAIL_W, height: 600 });
    expect(solved.dividers).toHaveLength(0);
    expect(solved.betweenIds).toEqual([]);
  });
});

describe("effective rail relation — one rule for the renderer and the published state", () => {
  const panes = [pane("a"), pane("b"), pane("c")];
  const relationOf = (layout: PlaneState, focusId: string, placement: "flow" | "pin" = "pin") =>
    resolveEffectiveRailRelation({
      contentId: "space-1",
      arrangement: solve(layout, focusId, { placement: { mode: placement }, pullFocused: false }),
      panes,
      placement,
      gap: box.gap,
    });

  it("PIN adjacent-left, adjacent-right and detached resolve to union/1, union/1 and independent/2", () => {
    const layout = standRail(rowPlane(["a", "b", "c"]), box, 1, RAIL_W)!;
    const left = relationOf(layout, "a");
    expect(left.state).toMatchObject({ side: "left", connected: true, borderMode: "union", pathCount: 1, source: "focus" });
    const right = relationOf(layout, "b");
    expect(right.state).toMatchObject({ side: "right", connected: true, borderMode: "union", pathCount: 1 });
    const far = relationOf(layout, "c");
    expect(far.state).toMatchObject({ side: "detached", connected: false, borderMode: "independent", pathCount: 2 });
    expect(far.targetRect).toEqual(far.paneRect);
  });

  it("FLOW joins the rail and the bound pane into one box", () => {
    const layout = standRail(rowPlane(["a", "b"]), box, 1, RAIL_W)!;
    const relation = relationOf(layout, "b", "flow");
    expect(relation.state.side).toBe("right");
    expect(relation.targetRect).toEqual(railBoundBox(solve(layout, "b").rail!, relation.paneRect!));
    expect(relation.targetRect).toEqual({ left: 500, top: 0, width: 500, height: 600 });
  });

  it("a rail with no set standing in it is a deterministic none/0 state even with a valid candidate", () => {
    const layout = standRail(rowPlane(["a", "b"]), box, 1, RAIL_W)!;
    const relation = resolveEffectiveRailRelation({
      contentId: "space-1",
      arrangement: solve(layout, "b", { railPresent: false }),
      panes,
      placement: "flow",
      gap: 0,
    });
    expect(relation.state).toMatchObject({
      source: "none", side: "detached", connected: false, borderMode: "none", pathCount: 0,
      relationId: "rail-relation/space-1/none",
    });
    expect(relation.targetRect).toBeNull();
  });

  it("a FLOW click commit draws the destination solve's outline at once, not the departing station", () => {
    const departed = solve(standRail(rowPlane(["a", "b"]), box, 0, RAIL_W)!, "a");
    const destination = solve(standRail(rowPlane(["a", "b"]), box, 1, RAIL_W)!, "b");
    const presented = resolvePresentedRailRelation({
      contentId: "space-1", displayed: departed, destination, panes, placement: "flow", gap: 0,
    });
    expect(presented.station).toBe(destination.station);
    expect(presented.state.boundPaneId).toBe("b");
  });

  it("PIN reads the displayed solve, because under PIN nothing travels", () => {
    const displayed = solve(standRail(rowPlane(["a", "b"]), box, 1, RAIL_W)!, "a", { placement: { mode: "pin" } });
    const destination = solve(standRail(rowPlane(["a", "b"]), box, 1, RAIL_W)!, "b", { placement: { mode: "pin" } });
    const presented = resolvePresentedRailRelation({
      contentId: "space-1", displayed, destination, panes, placement: "pin", gap: 0,
    });
    expect(presented.state.boundPaneId).toBe("a");
  });
});

describe("arrangement solver — a focused pane the rail cannot reach is exchanged to the front", () => {
  // a | b on top, c across the bottom: the line between a and b is crossed, so b's left is no
  // standing. The rail stands at the front line; focusing b exchanges a and b.
  const blocked = () => {
    const tall = columnPlane(["a", "c"]);
    return standRail(splitPane(tall, box, "a", "right", "b")!, box, 0, RAIL_W)!;
  };

  it("with 1 on top and 2 below, a focus at the back of the top row switches forward and reports the adjacency it created", () => {
    const solved = solve(blocked(), "b");
    expect(solved.swapped).toBe(true);
    expect(solved.cells.map((c) => c.id)).toEqual(["b", "a", "c"]);
    expect(rectOf(solved, "b").left).toBe(RAIL_W);
    expect(solved.betweenIds).toEqual([]);
  });

  it("a focus already beside the rail leaves the arrangement untouched (identity preserved)", () => {
    const layout = blocked();
    const solved = solve(layout, "a");
    expect(solved.swapped).toBe(false);
    expect(solved.display).toBe(layout);
  });

  it("without pull the arrangement stays and the wedged pane is reported", () => {
    const solved = solve(blocked(), "b", { pullFocused: false });
    expect(solved.swapped).toBe(false);
    expect(solved.cells.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(solved.betweenIds).toEqual(["a"]);
  });

  it("does not exchange under PIN — a focus change on a pinned rail is not a layout operation", () => {
    const solved = solve(blocked(), "b", { placement: { mode: "pin" } });
    expect(solved.swapped).toBe(false);
    expect(solved.betweenIds).toEqual(["a"]);
  });
});

describe("travel — only the panes the solve names, and width never changes", () => {
  it("only the pane the rail crosses translates by the rail's width", () => {
    const beside = standRail(rowPlane(["a", "b"]), box, 1, RAIL_W)!;
    const front = standRail(beside, box, 0, RAIL_W)!;
    const from = solve(beside, "b");
    const to = solve(front, "a");
    expect(arrangementMoves(from, to)).toEqual([{ id: "a", dLeft: -RAIL_W }]);
    expect(rectOf(from, "a").width).toBe(rectOf(to, "a").width);
    expect(rectOf(from, "b")).toEqual(rectOf(to, "b"));
  });

  // split-pane R5: a rail landing on the border charges the pane beside it half a gap less. That
  // pane translated by the rail's width and changed width by half a gap; it travels.
  it("a pane whose width changed by the border's half gap still travels", () => {
    // a | b over c at 0.3, the rail at the front, then beside c (measured 2026-09-05: a grew 2.7).
    const withGap: PlaneBox = { ...box, gap: 10 };
    const base = moveBoundary(splitPane(rowPlane(["a", "b"]), withGap, "b", "bottom", "c")!, withGap, "x", 1, 0.3)!;
    const front = standRail(base, withGap, 0, RAIL_W)!;
    const beside = standRail(front, withGap, flowRailLine(front, withGap, "c")!, RAIL_W)!;
    const from = solveArrangement({ layout: front, box: withGap, focusId: "a", placement: { mode: "flow" }, railPresent: true });
    const to = solveArrangement({ layout: beside, box: withGap, focusId: "c", placement: { mode: "flow" }, railPresent: true });
    const change = rectOf(to, "a").width - rectOf(from, "a").width;
    expect(Math.abs(change)).toBeGreaterThan(0);
    expect(Math.abs(change)).toBeLessThanOrEqual(withGap.gap / 2);
    expect(arrangementMoves(from, to).map((m) => m.id)).toEqual(["a"]);
  });

  it("an identical arrangement is not a move, and float error is not a move", () => {
    const layout = standRail(rowPlane(["a", "b"]), box, 1, RAIL_W)!;
    const solved = solve(layout, "b");
    expect(arrangementMoves(solved, solved)).toEqual([]);
    const nudged: Arrangement = {
      ...solved,
      cells: solved.cells.map((c) => ({ ...c, rect: { ...c.rect, left: c.rect.left + 0.2 } })),
    };
    expect(arrangementMoves(solved, nudged)).toEqual([]);
  });

  it("names the views of the panes that move, and no other", () => {
    const panes = [pane("a"), pane("b")];
    expect(viewIdsOfMoves(panes, [{ id: "a", dLeft: -RAIL_W }])).toEqual(["a-tab"]);
    expect(viewIdsOfMoves(panes, [])).toEqual([]);
  });

  it("takes the rendered rail width from the displayed solution", () => {
    const solved = solve(standRail(rowPlane(["a", "b"]), box, 1, RAIL_W)!, "b");
    expect(presentedRailWidth(solved)).toBe(RAIL_W);
    expect(presentedRailWidth(solve(rowPlane(["a", "b"]), "b", { railPresent: false }))).toBe(0);
    expect(presentedRailWidth(null)).toBe(0);
  });
});

describe("panes wedged between the rail and the focused pane", () => {
  it("answers with the panes wedged in by however far the rail could not travel", () => {
    // a | b | c on top, d across the bottom: only the front line stands.
    const layout = standRail(
      planeOf("a", { id: "d", side: "bottom", of: "a" }, { id: "b", side: "right", of: "a" }, { id: "c", side: "right", of: "b" }),
      box, 0, RAIL_W,
    )!;
    const solved = solve(layout, "c", { pullFocused: false });
    expect(solved.betweenIds).toEqual(["a", "b"]);
  });

  it("when the rail reaches, no pane is wedged", () => {
    const layout = standRail(rowPlane(["a", "b", "c"]), box, 2, RAIL_W)!;
    expect(solve(layout, "c").betweenIds).toEqual([]);
  });
});
