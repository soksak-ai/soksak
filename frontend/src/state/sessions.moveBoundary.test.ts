import { beforeEach, describe, expect, it } from "vitest";
import { useSessions, type Workspace, type Pane } from "./sessions";
import { rectsOf, standRail } from "./panePlane";
import { planeBox, setPlaneBox } from "./planeBox";
import { planeOf } from "../test/planes";

// Store boundary of split-pane R1 — a boundary is one number. A line two rows meet on moves as one
// line in one commit, whichever row's gutter is dragged; no intermediate fragmented state.

function group(id: string, viewId: string): Pane {
  return {
    id,
    activeTabId: viewId,
    tabs: [{ id: viewId, kind: "plugin", title: viewId, pluginId: "fixture", view: "content" }],
  };
}

// [tl | tr] over [bl | br], split on one vertical line.
function stackedWorkspace(): Workspace {
  useSessions.getState().bootstrapFirstWorkspace("/test/root");
  const base = useSessions.getState().workspaces[0];
  const layout = planeOf(
    "g-tl",
    { id: "g-tr", side: "right", of: "g-tl" },
    { id: "g-bl", side: "bottom", of: "g-tl" },
    { id: "g-br", side: "bottom", of: "g-tr" },
  );
  return {
    ...base,
    spaces: [{
      ...base.spaces[0],
      panes: [group("g-tl", "v-tl"), group("g-tr", "v-tr"), group("g-bl", "v-bl"), group("g-br", "v-br")],
      layout,
      activePaneId: "g-tl",
    }],
  };
}

const rects = () => rectsOf(useSessions.getState().workspaces[0].spaces[0].layout, planeBox());

beforeEach(() => {
  setPlaneBox({ width: 1000, height: 600, gap: 0 });
  useSessions.setState({ workspaces: [], activeId: "" });
});

describe("moveBoundary — one line, every row that meets on it", () => {
  it("both rows follow the line, by ratio", () => {
    const workspace = stackedWorkspace();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    const spaceId = workspace.spaces[0].id;

    const result = useSessions.getState().moveBoundary(workspace.id, spaceId, { axis: "x", line: 1 }, { ratio: 0.6 });

    expect(result).toEqual({ ok: true });
    expect(rects().get("g-tl")!.w).toBe(600);
    expect(rects().get("g-bl")!.w).toBe(600);
    expect(rects().get("g-tr")!.x).toBe(600);
    expect(rects().get("g-br")!.x).toBe(600);
  });

  it("both rows follow the line, by px", () => {
    const workspace = stackedWorkspace();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    const spaceId = workspace.spaces[0].id;

    expect(useSessions.getState().moveBoundary(workspace.id, spaceId, { axis: "x", line: 1 }, { px: 300 })).toEqual({ ok: true });
    expect(rects().get("g-tl")!.w).toBe(300);
    expect(rects().get("g-br")!.x).toBe(300);
  });

  it("keeps every pane at its floor", () => {
    const workspace = stackedWorkspace();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    const spaceId = workspace.spaces[0].id;

    expect(useSessions.getState().moveBoundary(workspace.id, spaceId, { axis: "x", line: 1 }, { px: 2 })).toEqual({ ok: true });
    expect(rects().get("g-tl")!.w).toBeGreaterThan(100);
  });

  // The rail is a card the layout does not move (split-pane R2): a boundary drag beside it changes
  // the rail's width and the slot on the other side pays.
  it("moves a boundary beside the rail without moving the rail's far edge", () => {
    const workspace = stackedWorkspace();
    const space = workspace.spaces[0];
    const withRail = { ...workspace, spaces: [{ ...space, layout: standRail(space.layout, planeBox(), 1, 100)! }] };
    useSessions.setState({ workspaces: [withRail], activeId: workspace.id });
    const before = rects();
    const rail = withRail.spaces[0].layout.cards.find((c) => c.id === "rail")!;

    expect(useSessions.getState().moveBoundary(workspace.id, space.id, { axis: "x", line: rail.c1 }, { px: 650 })).toEqual({ ok: true });
    const after = rects();
    expect(after.get("rail")!.x).toBe(before.get("rail")!.x);
    expect(after.get("rail")!.w).toBe(150);
    expect(after.get("g-tr")!.x).toBe(650);
  });

  it("answers TARGET_NOT_FOUND for a border, which is no boundary (no change)", () => {
    const workspace = stackedWorkspace();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    const before = useSessions.getState().workspaces[0];

    const result = useSessions.getState().moveBoundary(workspace.id, workspace.spaces[0].id, { axis: "x", line: 0 }, { ratio: 0.6 });

    expect(result).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
    expect(useSessions.getState().workspaces[0]).toBe(before);
  });

  it("answers TARGET_NOT_FOUND for a space that is not there (no change)", () => {
    const workspace = stackedWorkspace();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    const before = useSessions.getState().workspaces[0];

    const result = useSessions.getState().moveBoundary(workspace.id, "spc-ghost", { axis: "x", line: 1 }, { ratio: 0.6 });

    expect(result).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
    expect(useSessions.getState().workspaces[0]).toBe(before);
  });
});

describe("the rail's width and the place's width", () => {
  // Measured 2026-09-05 on restart: a gutter drag beside the rail had shrunk it to 293 on the
  // plane while the place's width still read 320, and the next boot pushed 320 back onto the
  // plane. One value: the plane's rail width is the place's width while the rail stands.
  it("a boundary beside the rail changes the rail's width, and the place's width follows", async () => {
    const { placeWidth, setPlaceWidth } = await import("./placeWidth");
    const workspace = stackedWorkspace();
    const space = workspace.spaces[0];
    setPlaceWidth("rail", 200);
    const withRail = { ...workspace, spaces: [{ ...space, layout: standRail(space.layout, planeBox(), 1, 200)! }] };
    useSessions.setState({ workspaces: [withRail], activeId: workspace.id });
    const rail = withRail.spaces[0].layout.cards.find((c) => c.id === "rail")!;

    expect(useSessions.getState().moveBoundary(workspace.id, space.id, { axis: "x", line: rail.c1 }, { px: 800 })).toEqual({ ok: true });
    const after = rects().get("rail")!;
    expect(after.w).toBe(300);
    expect(placeWidth("rail")).toBe(300);
  });
});
