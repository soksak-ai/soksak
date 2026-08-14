import { describe, expect, it } from "vitest";
import type { SplitTree } from "../state/splitTree";
import { leavesOf } from "../state/splitTree";
import { computeSplitLayout } from "./splitLayout";
import { isCleanRailStation } from "./railPlacement";
import {
  arrangementMoves,
  moveOffsetPx,
  projectionGeometryChanged,
  resolvePresentedRailRelation,
  resolveEffectiveRailRelation,
  solveArrangement,
  spanMoveAcross,
} from "./railArrangement";

type Pane = { id: string; activeTabId: string; tabs: Array<{ id: string }> };
const leaf = (id: string): SplitTree<Pane> => ({
  type: "leaf",
  value: { id, activeTabId: `v-${id}`, tabs: [{ id: `v-${id}` }] },
});
const order = (tree: SplitTree<Pane>): string[] =>
  leavesOf(tree).map((p) => p.id);

const HOST_W = 1000;
const RAIL_W = 246;

/** [a | b | c] three equal columns. */
const threeColumns = (): SplitTree<Pane> => ({
  type: "split",
  id: "root",
  dir: "row",
  sizes: [1 / 3, 1 / 3, 1 / 3],
  children: [leaf("a"), leaf("b"), leaf("c")],
});

/** Top 1 / bottom 2 (equal halves) — the user case where per-row vertical lines do not line up. */
const oneOverTwo = (): SplitTree<Pane> => ({
  type: "split",
  id: "root",
  dir: "col",
  sizes: [0.5, 0.5],
  children: [
    leaf("top"),
    {
      type: "split",
      id: "bottom",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [leaf("bl"), leaf("br")],
    },
  ],
});

const solve = (
  layout: SplitTree<Pane>,
  focusId: string | null,
  extra: Partial<Parameters<typeof solveArrangement<Pane>>[0]> = {},
) =>
  solveArrangement<Pane>({
    layout,
    focusId,
    placement: { mode: "flow" },
    railOpen: true,
    ...extra,
  });

/** Physical left (px) of a logical cell — the same composition as the consumer (GroupArea) layout formula. */
const leftPx = (
  arrangement: ReturnType<typeof solve>,
  id: string,
): number => {
  const cell = arrangement.cells.find((c) => c.id === id)!;
  const after = cell.rect.left >= arrangement.station - 1e-9;
  return (HOST_W * cell.rect.left) / 100 + (after ? RAIL_W : 0) - (RAIL_W * cell.rect.left) / 100;
};

describe("arrangement solver — station is a function of the grid and the focus", () => {
  it("projection geometry detects station, membership, and rect changes even when no pane translates", () => {
    const layout: SplitTree<Pane> = {
      type: "split", id: "two", dir: "row", sizes: [0.5, 0.5],
      children: [leaf("a"), leaf("b")],
    };
    const before = solveArrangement({
      layout, focusId: "a", placement: { mode: "pin", station: 50 }, railOpen: true,
    });
    const maximized = solveArrangement({
      layout, focusId: "a", maximizedId: "a",
      placement: { mode: "pin", station: 50 }, railOpen: true,
    });
    expect(arrangementMoves(before, maximized)).toEqual([]);
    expect(projectionGeometryChanged(before, maximized)).toBe(true);
    expect(projectionGeometryChanged(maximized, before)).toBe(true);
    expect(projectionGeometryChanged(before, structuredClone(before))).toBe(false);
  });

  it("in an even 3-column grid the station per focus is that pane's left clean line", () => {
    expect(solve(threeColumns(), "a").station).toBeCloseTo(0, 6);
    expect(solve(threeColumns(), "b").station).toBeCloseTo(100 / 3, 6);
    expect(solve(threeColumns(), "c").station).toBeCloseTo(200 / 3, 6);
    expect(solve(threeColumns(), "b").swapped).toBe(false);
  });

  it("PIN takes no focus input — the same line under any focus", () => {
    const canonical = threeColumns();
    const pinned = { placement: { mode: "pin" as const, station: 31 } };
    const atA = solve(canonical, "a", pinned);
    const atC = solve(canonical, "c", pinned);
    expect(atA.station).toBeCloseTo(100 / 3, 6); // snapped to the nearest clean line
    expect(atC.station).toBe(atA.station);
    // A pin fixes the layout, not only the rail. Focus changes only what the border binds to;
    // it does not change the order or identity of the canonical tree.
    expect(atA.displayLayout).toBe(canonical);
    expect(atC.displayLayout).toBe(canonical);
    expect(atC.swapped).toBe(false);
    expect(atA.swapped).toBe(false);
    expect(arrangementMoves(atA, atC)).toEqual([]);
  });

  it("an unresolved focus holds the current position instead of collapsing to 0", () => {
    const held = solve(threeColumns(), "ghost", { fallbackStation: 200 / 3 });
    expect(held.station).toBeCloseTo(200 / 3, 6);
    expect(held.swapped).toBe(false);
  });

  it("a closed sidebar has no rail to attach to — no switching", () => {
    const closed = solve(oneOverTwo(), "br", { railOpen: false });
    expect(closed.swapped).toBe(false);
    expect(order(closed.displayLayout)).toEqual(["top", "bl", "br"]);
  });

  it("maximize is one [rail | pane] plane — it does not consume the split underneath", () => {
    const max = solve(oneOverTwo(), "br", { maximizedId: "br" });
    expect(max.cells).toEqual([
      { id: "br", rect: { left: 0, top: 0, width: 100, height: 100 } },
    ]);
    expect(max.station).toBe(0);
    expect(max.swapped).toBe(false);
  });

  it("PIN maximize preserves the side the active pane was on and leaves the stored station unchanged", () => {
    const canonical = threeColumns();
    const placement = { mode: "pin" as const, station: 100 / 3 };

    const left = solve(canonical, "a", { placement, maximizedId: "a" });
    expect(left.station).toBe(100); // pane on the left, sidebar on the right

    const right = solve(canonical, "c", { placement, maximizedId: "c" });
    expect(right.station).toBe(0); // sidebar on the left, pane on the right

    const restored = solve(canonical, "a", { placement });
    expect(restored.station).toBeCloseTo(100 / 3, 6);
    expect(restored.displayLayout).toBe(canonical);
  });
});

describe("effective rail relation — one rule for the renderer and the published state", () => {
  const relation = (
    arrangement: ReturnType<typeof solve>,
    placement: "flow" | "pin",
    railOpen = true,
  ) => resolveEffectiveRailRelation({
    contentId: "c1",
    arrangement,
    placement,
    railOpen,
  });

  it("PIN adjacent-left, adjacent-right and detached resolve to union/1, union/1 and independent/2", () => {
    const layout = threeColumns();
    const extra = { placement: { mode: "pin" as const, station: 100 / 3 } };

    expect(relation(solve(layout, "a", extra), "pin").state).toMatchObject({
      boundTabId: "v-a",
      boundPaneId: "a",
      relationId: "rail-relation/c1/a/v-a",
      connected: true,
      side: "left",
      borderMode: "union",
      pathCount: 1,
    });
    expect(relation(solve(layout, "b", extra), "pin").state).toMatchObject({
      boundTabId: "v-b",
      boundPaneId: "b",
      connected: true,
      side: "right",
      borderMode: "union",
      pathCount: 1,
    });
    expect(relation(solve(layout, "c", extra), "pin").state).toMatchObject({
      boundTabId: "v-c",
      boundPaneId: "c",
      connected: false,
      side: "detached",
      borderMode: "independent",
      pathCount: 2,
    });
  });

  it("PIN maximize/restore in both directions preserves the relation side and restores the stored station", () => {
    const layout = threeColumns();
    const placement = { mode: "pin" as const, station: 100 / 3 };
    for (const [focusId, side] of [["a", "left"], ["b", "right"]] as const) {
      const before = solve(layout, focusId, { placement });
      const maximized = solve(layout, focusId, { placement, maximizedId: focusId });
      const restored = solve(layout, focusId, { placement });

      expect(relation(before, "pin").state.side).toBe(side);
      expect(relation(maximized, "pin").state.side).toBe(side);
      expect(relation(restored, "pin").state.side).toBe(side);
      expect(restored.station).toBe(before.station);
      expect(restored.displayLayout).toBe(layout);
    }
  });

  it("a closed rail is a deterministic none/0 state even with a valid candidate", () => {
    const resolved = relation(
      solve(threeColumns(), "b", {
        placement: { mode: "pin", station: 100 / 3 },
      }),
      "pin",
      false,
    );
    expect(resolved.state).toEqual({
      boundTabId: null,
      boundPaneId: null,
      relationId: "rail-relation/c1/none",
      placement: "pin",
      connected: false,
      side: "detached",
      borderMode: "none",
      pathCount: 0,
    });
    expect(resolved.targetRect).toBeNull();
  });

  it("a FLOW click commit does not mix the old displayed station with the new binding — it draws the destination solve's outline at once", () => {
    const layout = oneOverTwo();
    const displayed = solve(layout, "top");
    const destination = solve(layout, "br");
    const resolved = resolvePresentedRailRelation({
      contentId: "c1",
      displayed,
      destination,
      bindingTabId: "v-br",
      placement: "flow",
      railOpen: true,
    });

    expect(resolved.state).toMatchObject({
      boundPaneId: "br",
      boundTabId: "v-br",
      connected: true,
      borderMode: "union",
    });
    expect(resolved.targetRect).toEqual(
      destination.cells.find((cell) => cell.id === "br")?.rect,
    );
    expect(resolved.station).toBe(destination.station);
    expect(resolved.targetRect).not.toEqual({ left: 0, top: 50, width: 100, height: 50 });
  });

  it("where the FLOW destination focus changed first, a late old binding does not revert the outline", () => {
    const layout = oneOverTwo();
    const displayed = solve(layout, "top");
    const destination = solve(layout, "br");
    const resolved = resolvePresentedRailRelation({
      contentId: "c1",
      displayed,
      destination,
      // The actual order: activation's rail-binding store write arrived after the focus commit.
      bindingTabId: "v-top",
      placement: "flow",
      railOpen: true,
    });

    expect(resolved.state).toMatchObject({
      boundPaneId: "br",
      boundTabId: "v-br",
    });
    expect(resolved.station).toBe(destination.station);
  });
});

describe("arrangement solver — row mismatch exception (switching plus the dotted-line ground)", () => {
  it("with 1 on top and 2 below, a focus at the back of the bottom row switches forward and reports the adjacency it created", () => {
    const canonical = oneOverTwo();
    const frozen = structuredClone(canonical);
    const to = solve(canonical, "br");

    expect(order(to.displayLayout)).toEqual(["top", "br", "bl"]);
    expect(to.swapped).toBe(true); // the single ground for the dotted seam (natural adjacency is unmarked)
    const cells = computeSplitLayout(to.displayLayout).cells;
    const focused = cells.find((c) => c.value.id === "br")!;
    expect(isCleanRailStation(to.cleanLines, focused.rect.left)).toBe(true);
    expect(canonical).toEqual(frozen); // the canonical tree is not mutated
  });

  it("a focus already on a clean line leaves the arrangement untouched (identity preserved)", () => {
    const canonical = oneOverTwo();
    const at = solve(canonical, "top");
    expect(at.displayLayout).toBe(canonical);
    expect(at.swapped).toBe(false);
  });

  it("even a distant focus swaps with exactly one nearest left sibling — no global reorder", () => {
    // Top [terminal | playbox | astryxTop], bottom [about(1/3) | astryxBottom(2/3)].
    const reported: SplitTree<Pane> = {
      type: "split",
      id: "root",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "split",
          id: "top",
          dir: "row",
          sizes: [1 / 3, 1 / 3, 1 / 3],
          children: [leaf("terminal"), leaf("playbox"), leaf("astryxTop")],
        },
        {
          type: "split",
          id: "bottom",
          dir: "row",
          sizes: [1 / 3, 2 / 3],
          children: [leaf("about"), leaf("astryxBottom")],
        },
      ],
    };
    const to = solve(reported, "astryxTop");
    expect(order(to.displayLayout)).toEqual([
      "terminal",
      "astryxTop",
      "playbox",
      "about",
      "astryxBottom",
    ]);
    expect(to.station).toBeCloseTo(100 / 3, 5); // station does not move
    expect(to.cells.find((c) => c.id === "terminal")!.rect.left).toBeCloseTo(0, 5);
  });

  it("siblings of different widths swap their sizes together — each pane keeps its width", () => {
    const uneven: SplitTree<Pane> = {
      type: "split",
      id: "root",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "split",
          id: "top",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [leaf("t1"), leaf("t2")],
        },
        {
          type: "split",
          id: "bottom",
          dir: "row",
          sizes: [1 / 3, 2 / 3],
          children: [leaf("about"), leaf("astryx")],
        },
      ],
    };
    const to = solve(uneven, "astryx");
    expect(order(to.displayLayout)).toEqual(["t1", "t2", "astryx", "about"]);
    const cells = to.cells;
    expect(cells.find((c) => c.id === "astryx")!.rect.width).toBeCloseTo(200 / 3, 5);
    expect(cells.find((c) => c.id === "about")!.rect.width).toBeCloseTo(100 / 3, 5);
  });

  it("with no swap partner the arrangement stays and the leading clean line is used", () => {
    // Top wide / bottom [r | col(p, q)]. q is inside col, not a direct leaf child of the row, so
    // it has no swap partner. A blocked focus does not force a reorder — it takes the leading
    // (left) clean line.
    const blocked: SplitTree<Pane> = {
      type: "split",
      id: "root",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [
        leaf("wide"),
        {
          type: "split",
          id: "bottom",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [
            leaf("r"),
            {
              type: "split",
              id: "nest",
              dir: "col",
              sizes: [0.5, 0.5],
              children: [leaf("p"), leaf("q")],
            },
          ],
        },
      ],
    };
    const to = solve(blocked, "q");
    expect(to.displayLayout).toBe(blocked); // arrangement unchanged (identity)
    expect(to.swapped).toBe(false);
    expect(to.station).toBe(0); // the 50 line left of q is dirty because wide crosses it → the preceding line
  });
});

describe("travel — only the panes the solve names, and width never changes", () => {
  it("only the pane the rail crosses translates by railW", () => {
    const from = solve(threeColumns(), "a");
    const to = solve(threeColumns(), "b");
    const moves = arrangementMoves(from, to);

    expect(moves.map((m) => m.id)).toEqual(["a"]); // b and c do not move
    const [a] = moves;
    expect(a.dLeftPct).toBeCloseTo(0, 9); // the arrangement is unchanged — only the insertion point moves
    expect(moveOffsetPx(a, HOST_W, RAIL_W)).toBeCloseTo(RAIL_W, 6);

    // Width invariant (native resize 0) — every cell width is identical before and after the phase.
    for (const cell of to.cells) {
      const before = from.cells.find((c) => c.id === cell.id)!;
      expect(cell.rect.width).toBeCloseTo(before.rect.width, 9);
      expect(cell.rect.height).toBeCloseTo(before.rect.height, 9);
    }
  });

  it("the composed offset equals the physical left difference of the two arrangements exactly, switching and travel together included", () => {
    const canonical = oneOverTwo();
    const from = solve(canonical, "top");
    const to = solve(canonical, "br");
    const moves = arrangementMoves(from, to);

    // br changes arrangement by swapping and station is recomputed too — two axes overlap in one phase.
    const br = moves.find((m) => m.id === "br")!;
    expect(moveOffsetPx(br, HOST_W, RAIL_W)).toBeCloseTo(
      leftPx(from, "br") - leftPx(to, "br"),
      6,
    );
    const bl = moves.find((m) => m.id === "bl")!;
    expect(moveOffsetPx(bl, HOST_W, RAIL_W)).toBeCloseTo(
      leftPx(from, "bl") - leftPx(to, "bl"),
      6,
    );
    // Panes that did not take part are absent from the list (FLIP applies only to elements that move).
    expect(moves.some((m) => m.id === "top")).toBe(false);
  });

  it("an identical arrangement is not a move, and float error left by a resize is not a move", () => {
    const from = solve(threeColumns(), "b");
    expect(arrangementMoves(from, solve(threeColumns(), "b"))).toEqual([]);

    // Tiny float differences left by equalization — station and cell left differ only in the last digit.
    // Counting that as a move opens a phantom travel phase on every tab switch (real incident).
    const drifted: SplitTree<Pane> = {
      type: "split",
      id: "root",
      dir: "row",
      sizes: [0.333333, 0.333334, 0.333333],
      children: [leaf("a"), leaf("b"), leaf("c")],
    };
    expect(arrangementMoves(from, solve(drifted, "b"))).toEqual([]);
  });
});

describe("decoration span travel — the corridor moves on the same curve as the panes", () => {
  it("a divider the rail crosses moves by railW, one it does not cross moves 0", () => {
    // A divider is part of the corridor, not a pane — it never takes part in arrangement swaps, so
    // the only source of its offset is the change of insertion point. If that is 0 the cells glide
    // while the divider jumps to its destination at t0 and the screen is torn for the whole phase.
    const at50 = { left: 50, top: 0, width: 0, height: 100 };
    const crossed = spanMoveAcross(at50, 0, 100);
    expect(moveOffsetPx(crossed, HOST_W, RAIL_W)).toBeCloseTo(RAIL_W, 6);
    const untouched = spanMoveAcross(at50, 50, 50);
    expect(moveOffsetPx(untouched, HOST_W, RAIL_W)).toBeCloseTo(0, 6);
  });

  it("a horizontal span that comes to cross the rail has a start offset (the width change is outside translate)", () => {
    // Full-width col divider: at station 0 it starts to the right of the rail; at station 50 it
    // crosses the rail and runs from 0 to the gap — its left end moves by railW. The span's
    // 'length' also changes in the same transition and translate cannot express that (it is a
    // line, so the visual impact is small) — recorded as a known limit.
    const wide = { left: 0, top: 50, width: 100, height: 0 };
    expect(moveOffsetPx(spanMoveAcross(wide, 0, 50), HOST_W, RAIL_W)).toBeCloseTo(RAIL_W, 6);
  });
});

/** A PIN focus change alters selection state only; it is never promoted to a layout operation. */
describe("pinned rail — focus does not change the arrangement", () => {
  const two = (): SplitTree<Pane> => ({
    type: "split",
    id: "root",
    dir: "row",
    sizes: [0.5, 0.5],
    children: [leaf("L"), leaf("R")],
  });

  it("focus moving to the right keeps the sidebar and both panes in place and in order", () => {
    const canonical = two();
    const a = solveArrangement({
      layout: canonical,
      focusId: "R",
      placement: { mode: "pin", station: 0 },
      railOpen: true,
    });
    expect(a.cells.find((c) => c.id === "R")?.rect.left).toBe(50);
    expect(a.displayLayout).toBe(canonical);
    expect(a.swapped).toBe(false);
  });

  it("already next to the rail stays as is — no reason to move", () => {
    const a = solveArrangement({
      layout: two(),
      focusId: "L",
      placement: { mode: "pin", station: 0 },
      railOpen: true,
    });
    expect(a.cells.find((c) => c.id === "L")?.rect.left).toBe(0);
    expect(a.swapped).toBe(false);
  });

  /** With the rail closed there is nothing to attach to — the arrangement does not change. */
  it("a closed rail changes nothing", () => {
    const a = solveArrangement({
      layout: two(),
      focusId: "R",
      placement: { mode: "pin", station: 0 },
      railOpen: false,
    });
    expect(a.cells.find((c) => c.id === "R")?.rect.left).toBe(50);
  });
});

/** railPullFocused is FLOW's blocked-line resolution policy; it has no effect on PIN geometry. */
describe("pull setting — no intervention in a pinned arrangement", () => {
  const two = (): SplitTree<Pane> => ({
    type: "split",
    id: "root",
    dir: "row",
    sizes: [0.5, 0.5],
    children: [leaf("L"), leaf("R")],
  });

  it("without pull the pinned rail and panes all stay in place", () => {
    const a = solveArrangement({
      layout: two(),
      focusId: "R",
      placement: { mode: "pin", station: 0 },
      railOpen: true,
      pullFocused: false,
    });
    expect(a.cells.find((c) => c.id === "R")?.rect.left).toBe(50);
    expect(a.swapped).toBe(false);
    expect(a.station).toBe(0);
  });

  it("pull on does not swap a pinned pane", () => {
    const a = solveArrangement({
      layout: two(),
      focusId: "R",
      placement: { mode: "pin", station: 0 },
      railOpen: true,
      pullFocused: true,
    });
    expect(a.cells.find((c) => c.id === "R")?.rect.left).toBe(50);
    expect(a.station).toBe(0);
    expect(a.swapped).toBe(false);
  });
});

/**
 * **When the rail cannot move, name the panes wedged in between.**
 *
 * With pull off, the panes do not move and the rail travels to the focused pane. But the only
 * reachable lines are clean ones — if the bottom row is one piece the upper 50% line is blocked
 * and the rail stops at the line before it (0). Other panes are then between the rail and the
 * focused pane.
 *
 * Leaving those panes out of the answer makes the screen read as "nothing happened" (measured
 * 2026-08-02: the border disappeared entirely). Not moving does not mean doing nothing — the
 * covered panes must dim for the active pane to be visible.
 */
describe("panes wedged between the rail and the focused pane", () => {
  const blocked = (): SplitTree<Pane> => ({
    type: "split",
    id: "root",
    dir: "col",
    sizes: [0.5, 0.5],
    children: [
      { type: "split", id: "top", dir: "row", sizes: [0.5, 0.5], children: [leaf("L"), leaf("R")] },
      leaf("B"),
    ],
  });

  it("answers with the panes wedged in by however far the rail could not travel", () => {
    const a = solveArrangement({
      layout: blocked(),
      focusId: "R",
      placement: { mode: "pin", station: 0 },
      railOpen: true,
      pullFocused: false,
    });
    expect(a.station).toBe(0); // 50 is a blocked line, so the rail cannot reach it
    expect(a.betweenIds).toEqual(["L"]);
  });

  it("when the rail reaches, no pane is wedged", () => {
    const a = solveArrangement({
      layout: blocked(),
      focusId: "L",
      placement: { mode: "pin", station: 0 },
      railOpen: true,
      pullFocused: false,
    });
    expect(a.betweenIds).toEqual([]);
  });

  it("with pull on, a pinned pane still does not move and the wedged pane is reported", () => {
    const a = solveArrangement({
      layout: blocked(),
      focusId: "R",
      placement: { mode: "pin", station: 0 },
      railOpen: true,
      pullFocused: true,
    });
    expect(a.betweenIds).toEqual(["L"]);
  });
});
