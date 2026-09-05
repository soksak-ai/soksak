import { beforeEach, describe, expect, it } from "vitest";
import { projectArrangement, useSessions, type Workspace, type Pane } from "./sessions";
import { useSectionSets } from "./sectionSets";
import { railLine, railWidth, rectsOf, standRail } from "./panePlane";
import { planeBox, setPlaneBox } from "./planeBox";
import { setPlaceWidth } from "./placeWidth";
import { rowPlane } from "../test/planes";

function group(id: string, viewId: string): Pane {
  return {
    id,
    activeTabId: viewId,
    tabs: [
      {
        id: viewId,
        kind: "plugin",
        title: viewId,
        pluginId: "fixture",
        view: "content",
      },
    ],
  };
}

const RAIL_W = 100;

// [left | rail | right], the rail pinned between the two.
function twoColumnWorkspace(): Workspace {
  useSessions.getState().bootstrapFirstWorkspace("/test/root");
  const base = useSessions.getState().workspaces[0];
  const left = group("g-left", "v-left");
  const right = group("g-right", "v-right");
  return {
    ...base,
    regionOpen: { ...base.regionOpen, rail: true },
    railPlacement: { mode: "pin" },
    spaces: [
      {
        ...base.spaces[0],
        activePaneId: right.id,
        panes: [left, right],
        layout: standRail(rowPlane([left.id, right.id]), planeBox(), 1, RAIL_W)!,
      },
    ],
  };
}

const layoutNow = () => useSessions.getState().workspaces[0].spaces[0].layout;

beforeEach(() => {
  setPlaneBox({ width: 1000, height: 600, gap: 0 });
  setPlaceWidth("rail", RAIL_W);
  useSessions.setState({ workspaces: [], activeId: "" });
  useSectionSets.setState({ sets: [], byPlugin: {}, left: null });
  const set = useSectionSets.getState().create("fixture rail");
  useSectionSets.getState().arrange(set.id, ["fixture.section"]);
  useSectionSets.getState().link("fixture", "rail", set.id);
});

describe("a pinned rail stays where it stands", () => {
  it("does not draw a rail for an open link whose set has no sections", () => {
    const workspace = twoColumnWorkspace();
    const empty = useSectionSets.getState().create("empty");
    useSectionSets.getState().link("fixture", "rail", empty.id);
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });

    expect(projectArrangement(workspace)!.railPresent).toBe(false);
  });

  // split-pane R3: a card occupies its slots, so no pane crosses the pinned line. A boundary drag
  // beside the rail changes the rail's width, and the pane on the other side pays (R5).
  it("a boundary drag beside the pinned rail changes the rail's width and moves no pane across it", () => {
    const workspace = twoColumnWorkspace();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    const rail = layoutNow().cards.find((c) => c.id === "rail")!;

    const result = useSessions.getState().moveBoundary(workspace.id, workspace.spaces[0].id, { axis: "x", line: rail.c1 }, { px: 650 });

    expect(result).toEqual({ ok: true });
    const rects = rectsOf(layoutNow(), planeBox());
    expect(rects.get("rail")).toMatchObject({ x: 500, w: 150 });
    expect(rects.get("g-left")!.w).toBe(500);
    expect(rects.get("g-right")!.x).toBe(650);
    expect(railLine(layoutNow())).toBe(1);
  });

  it("a focus change leaves the rail on its line and the placement pinned", () => {
    const workspace = twoColumnWorkspace();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });

    expect(useSessions.getState().setActiveGroup(workspace.id, "g-left")).toEqual({ ok: true });
    expect(railLine(layoutNow())).toBe(1);
    expect(projectArrangement(useSessions.getState().workspaces[0])!.station).toBe(500);
    expect(useSessions.getState().workspaces[0].railPlacement).toEqual({ mode: "pin" });
  });

  it("maximize shows the rail at the left of the one pane, and restore brings it back to its line", () => {
    const workspace = twoColumnWorkspace();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });

    expect(useSessions.getState().maximizeView(workspace.id, "v-right")).toEqual({ ok: true, viewId: "v-right" });
    expect(projectArrangement(useSessions.getState().workspaces[0])!.station).toBe(0);
    expect(railLine(layoutNow())).toBe(1);

    expect(useSessions.getState().restoreView(workspace.id)).toEqual({ ok: true, viewId: "v-right" });
    expect(projectArrangement(useSessions.getState().workspaces[0])!.station).toBe(500);
  });

  // split-pane R7: a card can leave; its room goes to the neighbour that can grow. The rail is fixed
  // and does not grow, so the pane on the rail's other side takes the room and the rail stays.
  it("closing the pane beside the rail leaves the rail standing at its width", () => {
    const workspace = twoColumnWorkspace();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });

    expect(useSessions.getState().closeGroup(workspace.id, "g-left")).toEqual({ ok: true, activePaneId: "g-right" });
    const rects = rectsOf(layoutNow(), planeBox());
    expect(railWidth(layoutNow())).toBe(RAIL_W);
    expect(rects.get("rail")).toMatchObject({ x: 0, w: RAIL_W });
    expect(rects.get("g-right")).toMatchObject({ x: RAIL_W, w: 1000 - RAIL_W });
  });
});

describe("before the plane is measured", () => {
  // Measured 2026-09-05: on a 0-wide plane every standing is at px 0, so the line chosen for the
  // focused pane was the last one, and the rail moved there before the host had measured anything.
  it("settles nothing — the rail stays where it stands", () => {
    const workspace = twoColumnWorkspace();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    setPlaneBox({ width: 0, height: 0, gap: 0 });
    const before = useSessions.getState().workspaces[0].spaces[0].layout;
    expect(useSessions.getState().setActiveGroup(workspace.id, "g-left")).toEqual({ ok: true });
    expect(useSessions.getState().workspaces[0].spaces[0].layout).toBe(before);
    expect(useSessions.getState().settleRail(workspace.id)).toEqual({ ok: true });
    expect(useSessions.getState().workspaces[0].spaces[0].layout).toBe(before);
    expect(useSessions.getState().setRailWidth(workspace.id, 200)).toEqual({ ok: true });
    expect(useSessions.getState().workspaces[0].spaces[0].layout).toBe(before);
  });
});
