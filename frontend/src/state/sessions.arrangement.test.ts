import { beforeEach, describe, expect, it } from "vitest";
import {
  projectArrangement,
  useSessions,
  type Workspace,
  type Pane,
} from "./sessions";
import { equalizeAxis, railLine, splitPane } from "./panePlane";
import { planeBox, setPlaneBox } from "./planeBox";
import { setPlaceWidth } from "./placeWidth";
import { useSectionSets } from "./sectionSets";
import { rowPlane } from "../test/planes";

const group = (id: string): Pane => ({
  id,
  activeTabId: `v-${id}`,
  tabs: [
    {
      id: `v-${id}`,
      kind: "plugin",
      title: id,
      pluginId: "fixture",
      view: "content",
    },
  ],
});

const RAIL_W = 60;

// [db | (design | ghostty) over terminal | kanban], the columns in thirds of a 1500×800 plane.
function workspaceFixture(): Workspace {
  useSessions.getState().bootstrapFirstWorkspace("/test/root");
  const base = useSessions.getState().workspaces[0];
  const box = planeBox();
  const thirds = equalizeAxis(rowPlane(["db", "design", "kanban"]), box, "x");
  const stacked = splitPane(thirds, box, "design", "bottom", "terminal")!;
  const layout = splitPane(stacked, box, "design", "right", "ghostty")!;
  return {
    ...base,
    regionOpen: { ...base.regionOpen, rail: true },
    railPlacement: { mode: "flow" },
    spaces: [
      {
        ...base.spaces[0],
        activePaneId: "ghostty",
        panes: ["db", "design", "ghostty", "terminal", "kanban"].map(group),
        layout,
      },
    ],
  };
}

const panesOf = (workspace: Workspace) =>
  workspace.spaces[0].layout.cards.filter((c) => c.id !== "rail");

beforeEach(() => {
  setPlaneBox({ width: 1500, height: 800, gap: 0 });
  setPlaceWidth("rail", RAIL_W);
  useSessions.setState({ workspaces: [], activeId: "" });
  useSectionSets.setState({ sets: [], byPlugin: {}, left: null });
  const set = useSectionSets.getState().create("fixture rail");
  useSectionSets.getState().arrange(set.id, ["fixture.section"]);
  useSectionSets.getState().link("fixture", "rail", set.id);
});

const withRail = (workspace: Workspace) => projectArrangement(workspace, true, true)!;
const cell = (workspace: Workspace, id: string) => withRail(workspace).cells.find((c) => c.id === id)!.rect;

describe("session arrangement — the solution decides the display and the panes' plane stays unchanged", () => {
  it("a blocked focus (ghostty) is displayed as an exchanged arrangement and the panes stay where they are", () => {
    // The line between design and ghostty is crossed by terminal, so the rail stands at the third
    // in front of them and ghostty is exchanged with design on the screen.
    const workspace = workspaceFixture();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    useSessions.getState().settleRail(workspace.id);

    const stored = useSessions.getState().workspaces[0];
    const solved = withRail(stored);
    expect(solved.railPresent).toBe(true);
    expect(solved.station).toBeCloseTo(500, 6);
    expect(solved.swapped).toBe(true);
    expect(cell(stored, "ghostty").left).toBeCloseTo(500 + RAIL_W, 6);
    expect(cell(stored, "design").left).toBeGreaterThan(cell(stored, "ghostty").left);
    // The plane the space stores holds the panes as they were; only the rail's slot was added at
    // line 1, so every span past it reads one line further.
    expect(panesOf(stored)).toEqual(panesOf(workspace).map((c) => ({
      ...c, c0: c.c0 + (c.c0 >= 1 ? 1 : 0), c1: c.c1 + (c.c1 > 1 ? 1 : 0),
    })));
  });

  it("moving focus to a pane the rail can reach displays the plane as stored", () => {
    const workspace = workspaceFixture();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    useSessions.getState().setActiveGroup(workspace.id, "terminal");

    const stored = useSessions.getState().workspaces[0];
    const solved = withRail(stored);
    expect(solved.swapped).toBe(false);
    expect(solved.display).toBe(stored.spaces[0].layout);
    expect(railLine(stored.spaces[0].layout)).toBe(1);
    expect(cell(stored, "design").left).toBeCloseTo(500 + RAIL_W, 6);
    expect(cell(stored, "ghostty").left).toBeGreaterThan(cell(stored, "design").left);
  });

  it("maximizing a tab is a single [rail | pane] plane, and restore brings the original arrangement back", () => {
    const workspace = workspaceFixture();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    useSessions.getState().settleRail(workspace.id);
    const canonical = useSessions.getState().workspaces[0].spaces[0].layout;

    expect(useSessions.getState().maximizeView(workspace.id, "v-ghostty")).toEqual({
      ok: true,
      viewId: "v-ghostty",
    });
    const maximized = useSessions.getState().workspaces[0];
    const solved = withRail(maximized);
    expect(solved.cells).toEqual([
      { id: "ghostty", rect: { left: RAIL_W, top: 0, width: 1500 - RAIL_W, height: 800 } },
    ]);
    expect(solved.station).toBe(0);
    expect(maximized.regionOpen.rail).toBe(true);
    expect(maximized.spaces[0].layout).toEqual(canonical);

    expect(useSessions.getState().restoreView(workspace.id)).toEqual({
      ok: true,
      viewId: "v-ghostty",
    });
    const restored = useSessions.getState().workspaces[0];
    expect(restored.spaces[0].maximizedTabId).toBeUndefined();
    expect(restored.spaces[0].layout).toEqual(canonical);
  });

  it("a closed rail leaves nothing to attach to — no exchange happens", () => {
    const workspace = workspaceFixture();
    useSessions.setState({
      workspaces: [{ ...workspace, regionOpen: { ...workspace.regionOpen, rail: false } }],
      activeId: workspace.id,
    });
    const solved = projectArrangement(useSessions.getState().workspaces[0])!;
    expect(solved.railPresent).toBe(false);
    expect(solved.swapped).toBe(false);
  });
});

// Maximize means "this view fills the space", so the filling panel is the group that holds the view. If the
// projection uses the active group instead, the moment the two diverge — the moment a tab in another group is
// double-clicked — it collapses to a panel without the maximized view and nothing is drawn (measured:
// maximizedTabId=v35 (is in g3) but layout={"panel":"g5"}, 0 DOM slots, whole window blank).
describe("maximize — the filling panel is the group that holds the view", () => {
  it("a maximized view outside the active group collapses to that view's group", () => {
    const workspace = workspaceFixture();
    const content = workspace.spaces[0];
    // Active group is ghostty, maximize target is a view of kanban — the diverged state.
    const withMax: Workspace = {
      ...workspace,
      spaces: [{ ...content, activePaneId: "ghostty", maximizedTabId: "v-kanban" }],
    };
    useSessions.setState({ workspaces: [withMax], activeId: withMax.id });

    const solved = withRail(useSessions.getState().workspaces[0]);
    expect(solved.cells.map((c) => c.id)).toEqual(["kanban"]);
  });

  it("a maximized view inside the active group collapses to that same group", () => {
    const workspace = workspaceFixture();
    const content = workspace.spaces[0];
    const withMax: Workspace = {
      ...workspace,
      spaces: [{ ...content, activePaneId: "ghostty", maximizedTabId: "v-ghostty" }],
    };
    useSessions.setState({ workspaces: [withMax], activeId: withMax.id });

    const solved = withRail(useSessions.getState().workspaces[0]);
    expect(solved.cells.map((c) => c.id)).toEqual(["ghostty"]);
  });
});
